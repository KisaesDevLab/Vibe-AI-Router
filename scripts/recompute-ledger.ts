/**
 * Ledger recompute (9.10): replays cost from stored token counts against the pricing history
 * effective at each row's timestamp. Use after pricing corrections.
 *
 *   DATABASE_URL=… pnpm tsx scripts/recompute-ledger.ts [--from 2026-01-01] [--to 2026-12-31] [--dry]
 */
import { and, eq, gte, lte } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import { usageLedger } from '../db/schema.js';
import { pricingAt } from '../src/catalog/service.js';
import { computeCost } from '../src/ledger/cost.js';

const out = (m: string): void => void process.stdout.write(m + '\n');

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(1);
  }
  const dry = process.argv.includes('--dry');
  const from = argValue('--from');
  const to = argValue('--to');

  const { db, close } = createDb(url, 2);
  try {
    const wheres = [] as Parameters<typeof and>;
    if (from) wheres.push(gte(usageLedger.ts, new Date(from)));
    if (to) wheres.push(lte(usageLedger.ts, new Date(to)));
    const rows = await db.query.usageLedger.findMany({
      where: wheres.length ? and(...wheres) : undefined,
    });
    const modelRows = await db.query.models.findMany();
    const byCanonical = new Map(modelRows.map((m) => [m.canonicalId, m]));

    let changed = 0;
    let unresolved = 0;
    for (const row of rows) {
      if (!row.modelServed) continue;
      const model = byCanonical.get(row.modelServed);
      if (!model) {
        unresolved++;
        continue;
      }
      const pricing = await pricingAt(db, model.id, row.ts);
      const cost = computeCost(
        {
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          cachedReadTokens: row.cachedReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          estimated: row.costEstimated,
        },
        pricing,
      );
      const differs =
        (row.costCents === null) !== (cost.costCents === null) ||
        (row.costCents !== null && cost.costCents !== null && Number(row.costCents) !== Number(cost.costCents)) ||
        row.costUnknown !== cost.costUnknown;
      if (differs) {
        changed++;
        if (!dry) {
          await db
            .update(usageLedger)
            .set({ costCents: cost.costCents, costUnknown: cost.costUnknown })
            .where(eq(usageLedger.id, row.id));
        }
      }
    }
    out(`${rows.length} rows scanned, ${changed} ${dry ? 'would change' : 'updated'}, ${unresolved} unresolved models`);
    void eq;
  } finally {
    await close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(String(e instanceof Error ? e.message : e) + '\n');
  process.exit(1);
});
