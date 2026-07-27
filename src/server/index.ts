import { loadEnv } from '../config/env.js';
import { createDb } from '../db/client.js';
import { createLogger } from '../lib/logger.js';
import { NoopLedger } from '../gateway/pipeline.js';
import { createAdapterRegistry } from '../adapters/registry.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');
  const handle = createDb(env.DATABASE_URL);
  const app = buildApp({
    env,
    gateway: {
      deps: { db: handle.db, adapters: createAdapterRegistry(), ledger: new NoopLedger(), log },
    },
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
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
