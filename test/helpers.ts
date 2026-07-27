import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';

/**
 * Full reset for DB-backed suites that assert exact counts: drop everything, re-migrate,
 * re-seed. Suites run serially (vitest fileParallelism=false) so this is safe.
 */
export async function resetDb(databaseUrl: string): Promise<void> {
  await migrate(databaseUrl, 'down', Infinity);
  await migrate(databaseUrl, 'up');
  await seed(databaseUrl);
}
