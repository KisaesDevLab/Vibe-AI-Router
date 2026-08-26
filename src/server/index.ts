import { randomBytes } from 'node:crypto';
import { lt } from 'drizzle-orm';
import { usageLedger } from '../../db/schema.js';
import { loadEnv } from '../config/env.js';
import { createDb } from '../db/client.js';
import { SessionStore } from '../admin-api/session.js';
import { createLogger } from '../lib/logger.js';
import { DbLedger } from '../ledger/writer.js';
import { createAdapterRegistry } from '../adapters/registry.js';
import { keyringFromEnv } from '../vault/crypto.js';
import { CredentialVault } from '../vault/service.js';
import { HealthMonitor } from '../vault/health.js';
import { PolicyEngine } from '../policy/engine.js';
import { writeAudit } from '../protect/audit.js';
import { CircuitBreaker } from '../resilience/breaker.js';
import { LoadShedGuard } from '../resilience/shed.js';
import { RateLimiter } from '../resilience/limiter.js';
import { Metrics } from '../ops/metrics.js';
import { ResponseCache } from '../ops/cache.js';
import { buildApp, servesGateway } from './app.js';

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

  // resilience layer (Phase 10)
  const breaker = new CircuitBreaker({ openDurationMs: env.BREAKER_OPEN_MS });
  breaker.onTransition = (providerId, from, to, errorRate) => {
    log.warn({ providerId, from, to, errorRate }, 'circuit breaker transition');
    void (async (): Promise<void> => {
      const firm = await handle.db.query.firms.findFirst();
      if (firm) {
        await writeAudit(handle.db, {
          firmId: firm.id,
          event: 'breaker_transition',
          provider: providerId,
          detail: { from, to, errorRate },
        });
      }
    })().catch(() => {});
  };
  const resilience = {
    breaker,
    shed: new LoadShedGuard(env.UPSTREAM_MAX_CONCURRENCY, env.UPSTREAM_QUEUE_CAP),
    totalTimeoutMs: env.ROUTER_TIMEOUT_TOTAL_MS,
    streamIdleTimeoutMs: env.ROUTER_TIMEOUT_STREAM_IDLE_MS,
    verifyResponses: env.ROUTER_VERIFY_RESPONSES,
  };
  const rateLimits = {
    perToken: new RateLimiter(env.RATE_LIMIT_PER_TOKEN_RPM),
    perUser: new RateLimiter(env.RATE_LIMIT_PER_USER_RPM),
  };
  const metrics = new Metrics(() => breaker.snapshot());
  const responseCache = new ResponseCache();
  const limiterPrune = setInterval(() => {
    rateLimits.perToken.prune();
    rateLimits.perUser.prune();
  }, 300_000);
  limiterPrune.unref();

  const sessions = new SessionStore(env.SESSION_SECRET ?? randomBytes(32).toString('base64'));
  if (!env.SESSION_SECRET) log.warn('SESSION_SECRET not set — admin sessions reset on restart');

  const app = buildApp({
    env,
    adminApi: {
      sessions,
      secureCookies: env.SECURE_COOKIES,
      ...(vault ? { vault } : {}),
      ...(env.LEDGER_RETENTION_DAYS ? { retentionDays: env.LEDGER_RETENTION_DAYS } : {}),
      adapterFor: (kind: string) => adapters.get(kind),
      breakerSnapshot: () => breaker.snapshot(),
    },
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
        resilience,
        rateLimits,
        metrics,
        responseCache,
        ssrfDenyPrivateCloud: env.SSRF_DENY_PRIVATE_CLOUD,
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

  // Background data work (auto-revoke, retention purge, catalog sync) is role-gated to the
  // gateway: in a split deployment both containers share one database, and un-gated timers
  // ran every job twice against the same tables (found by Kurt in appliance integration —
  // the catalog sync was worked around there with CATALOG_SYNC_CRON="", fixed here at the
  // source). The gateway is the container that owns the data plane.
  const runsBackgroundJobs = servesGateway(env.ROUTER_ROLE);

  // hourly auto-revoke of expired grace credentials (6.4)
  const autoRevoke =
    vault && runsBackgroundJobs
      ? setInterval(() => void vault.autoRevokeExpired().catch(() => {}), 3600_000)
      : undefined;
  autoRevoke?.unref();

  // optional daily ledger retention purge (13.7); audit_log is immutable by design (Q-050)
  if (env.LEDGER_RETENTION_DAYS && runsBackgroundJobs) {
    const days = env.LEDGER_RETENTION_DAYS;
    const purge = async (): Promise<void> => {
      const cutoff = new Date(Date.now() - days * 86_400_000);
      const gone = await handle.db.delete(usageLedger).where(lt(usageLedger.ts, cutoff)).returning({
        id: usageLedger.id,
      });
      if (gone.length > 0) log.info({ purged: gone.length, cutoff }, 'ledger retention purge');
    };
    const retention = setInterval(() => void purge().catch(() => {}), 86_400_000);
    retention.unref();
    void purge().catch(() => {});
  }

  const scheduler =
    env.CATALOG_SYNC_CRON && runsBackgroundJobs
      ? (await import('../catalog/scheduler.js')).startCatalogScheduler(
          handle.db,
          log,
          env.CATALOG_SYNC_CRON,
          () => metrics.markSync(),
          // enable nightly live-provider model discovery only when the vault can supply keys
          // (Q-082); without MASTER_KEY there are no cloud credentials to discover with anyway
          vault ? (providerId: string) => vault.getActiveApiKey(providerId) : undefined,
        )
      : undefined;

  // graceful shutdown (13.8): stop accepting, drain in-flight (incl. SSE + ledger writes),
  // force-close stragglers after a 15s grace window.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down — draining in-flight requests');
    if (scheduler) void scheduler.stop();
    const force = setTimeout(() => {
      app.log.warn('grace window elapsed — forcing close');
      process.exit(1);
    }, 15_000);
    force.unref();
    await app.close(); // waits for in-flight responses; ledger writes happen inside them
    await health.flush();
    await handle.close();
    clearTimeout(force);
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
