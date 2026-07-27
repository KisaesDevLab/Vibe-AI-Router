import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { migrate, status } from '../db/migrate.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

// DB-backed suite: self-skips when no test database is configured (unit tier stays runnable anywhere).
describe.skipIf(!url)('migration runner (reversibility: up → down → up)', () => {
  it('runs all migrations up, fully down, and up again', async () => {
    const dbUrl = url as string;
    await migrate(dbUrl, 'down', Infinity); // clean slate regardless of prior state

    const up1 = await migrate(dbUrl, 'up');
    expect(up1.length).toBeGreaterThan(0);
    expect((await status(dbUrl)).every((m) => m.applied)).toBe(true);

    const down = await migrate(dbUrl, 'down', Infinity);
    expect(down.length).toBe(up1.length);
    expect((await status(dbUrl)).every((m) => !m.applied)).toBe(true);

    const up2 = await migrate(dbUrl, 'up');
    expect(up2).toEqual(up1);

    // After down-all, no application tables may linger (reversibility is real, not cosmetic).
    const sql = postgres(dbUrl, { max: 1 });
    try {
      await migrate(dbUrl, 'down', Infinity);
      const tables = await sql<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_migrations'`;
      expect(tables.map((t) => t.tablename)).toEqual([]);
    } finally {
      await sql.end();
      await migrate(dbUrl, 'up'); // leave DB migrated for subsequent suites
    }
  });
});
