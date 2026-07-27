import { loadEnv } from '../config/env.js';
import { createDb } from '../db/client.js';
import { createLogger } from '../lib/logger.js';
import { DbLedger } from '../ledger/writer.js';
import { createAdapterRegistry } from '../adapters/registry.js';
import { keyringFromEnv } from '../vault/crypto.js';
import { CredentialVault } from '../vault/service.js';
import { HealthMonitor } from '../vault/health.js';
import { PolicyEngine } from '../policy/engine.js';
import { writeAudit } from '../protect/audit.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');
  const handle = createDb(env.DATABASE_URL);
  const adapters = createAdapterRegistry();

  // vault (Phase 6): present only when MASTER_KEY is configured — local-only mode runs without
  const keyring = keyringFromEnv(env);
  let vault: CredentialVault | undefined;
  if (keyring) {
    vault = new CredentialVault(handle.db, keyring, log, env.CREDENTIAL_GRACE_HOURS);
    await vault.startupCheck(); // fail loudly on undecryptable credentials (6.7)
  } else {
    log.warn('MASTER_KEY not set — cloud provider credentials unavailable (local-only mode)');
  }
  const health = new HealthMonitor(handle.db, log);
  const engine = new PolicyEngine(handle.db);

  const app = buildApp({
    env,
    gateway: {
      deps: {
        db: handle.db,
        adapters,
        ledger: new DbLedger(handle.db),
        log,
        engine,
        ...(vault ? { getApiKey: (providerId: string) => vault.getActiveApiKey(providerId) } : {}),
        recordHealth: (providerId, firmId, label, ok) => health.record(providerId, firmId, label, ok),
        audit: (entry) => {
          void writeAudit(handle.db, entry).catch((err: unknown) =>
            log.error({ err, event: entry.event }, 'audit write failed'),
          );
        },
      },
    },
  });

  if (env.ADMIN_BOOTSTRAP_TOKEN) {
    const { registerBootstrapAdmin } = await import('../admin-api/bootstrap.js');
    registerBootstrapAdmin(app, {
      db: handle.db,
      log,
      adminToken: env.ADMIN_BOOTSTRAP_TOKEN,
      ...(vault ? { vault } : {}),
      adapterFor: (kind: string) => adapters.get(kind),
      engine,
    });
  }

  // hourly auto-revoke of expired grace credentials (6.4)
  const autoRevoke = vault
    ? setInterval(() => void vault.autoRevokeExpired().catch(() => {}), 3600_000)
    : undefined;
  autoRevoke?.unref();

  const scheduler = env.CATALOG_SYNC_CRON
    ? (await import('../catalog/scheduler.js')).startCatalogScheduler(handle.db, log, env.CATALOG_SYNC_CRON)
    : undefined;

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    if (scheduler) void scheduler.stop();
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((err: unknown) => {
  // Logger may not exist yet (env validation failure) — write plainly and exit non-zero.
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
