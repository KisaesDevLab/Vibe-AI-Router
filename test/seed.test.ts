import { describe, expect, it } from 'vitest';
import { seed } from '../db/seed.js';
import { migrate } from '../db/migrate.js';
import { createDb } from '../src/db/client.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

describe.skipIf(!url)('seed (Phase 1.15)', () => {
  it('produces a navigable dataset and is idempotent', async () => {
    const dbUrl = url as string;
    await migrate(dbUrl, 'up');
    await seed(dbUrl);
    await seed(dbUrl); // idempotency: second run must not throw or duplicate

    const { db, close } = createDb(dbUrl, 2);
    try {
      const firm = await db.query.firms.findFirst({ where: (f, { eq }) => eq(f.slug, 'demo-firm') });
      expect(firm).toBeDefined();

      const allModels = await db.query.models.findMany();
      expect(allModels.length).toBe(5);

      const classes = await db.query.taskClasses.findMany();
      expect(classes.length).toBe(3);
      expect(new Set(classes.map((c) => c.sensitivity))).toEqual(
        new Set(['local_only', 'cloud_deidentified', 'cloud_allowed']),
      );

      const pols = await db.query.policies.findMany();
      expect(pols.length).toBe(3);

      // local_only class must default to a local model (sensitivity invariant, seed-level check)
      const localClass = classes.find((c) => c.sensitivity === 'local_only');
      const localPolicy = pols.find((p) => p.taskClassId === localClass?.id);
      const defaultModel = allModels.find((m) => m.id === localPolicy?.defaultModelId);
      expect(defaultModel?.providerKind).toBe('local');

      const pricing = await db.query.modelPricing.findMany();
      expect(pricing.length).toBe(5); // one row per model, not duplicated on re-seed

      const tokens = await db.query.appTokens.findMany();
      expect(tokens.length).toBe(1);
      expect(tokens[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await close();
    }
  });

  it('audit_log rejects UPDATE and DELETE (append-only trigger)', async () => {
    const dbUrl = url as string;
    const { sql, close } = createDb(dbUrl, 1);
    try {
      const [firm] = await sql<{ id: string }[]>`SELECT id FROM firms LIMIT 1`;
      expect(firm).toBeDefined();
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO audit_log (firm_id, event, detail) VALUES (${firm!.id}, 'config_change', '{}')
        RETURNING id`;
      await expect(sql`UPDATE audit_log SET event = 'tampered' WHERE id = ${row!.id}`).rejects.toThrow(
        /append-only/,
      );
      await expect(sql`DELETE FROM audit_log WHERE id = ${row!.id}`).rejects.toThrow(/append-only/);
    } finally {
      await close();
    }
  });
});
