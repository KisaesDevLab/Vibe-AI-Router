/**
 * Cost breakdown (11.7b): the single grouped query behind the admin Costs view. The properties
 * that matter are that every ledger row lands in exactly one (app, task class, model) bucket —
 * so pivoting to any one dimension reproduces the same firm total — and that unpriced requests
 * stay COUNTED and visible rather than silently reading as $0 (ledger invariant 8).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../src/db/client.js';
import { resetDb } from './helpers.js';
import { firms, taskClasses, usageLedger } from '../db/schema.js';
import { costBreakdown, type CostBreakdownRow } from '../src/ledger/aggregate.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

/** sum one dimension's totals the way the UI pivots them */
const sumBy = (rows: CostBreakdownRow[], key: 'app' | 'taskClass' | 'model'): Map<string, number> => {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r[key], (out.get(r[key]) ?? 0) + Number(r.costCents));
  return out;
};

describe.skipIf(!url)('costBreakdown (DB)', () => {
  let handle: DbHandle;
  let firmId: string;

  beforeAll(async () => {
    await resetDb(url!);
    handle = createDb(url!, 2);
    firmId = (await handle.db.query.firms.findFirst({ orderBy: firms.createdAt }))!.id;

    const tc = await handle.db.query.taskClasses.findMany({ limit: 2, orderBy: taskClasses.key });
    const [classA, classB] = tc;
    if (!classA || !classB) throw new Error('seed provides task classes');

    const row = (
      i: number,
      app: string,
      taskClassId: string | null,
      model: string | null,
      costCents: string | null,
      costUnknown = false,
    ): typeof usageLedger.$inferInsert => ({
      requestId: `cost-test-${i}`,
      firmId,
      app,
      taskClassId,
      modelServed: model,
      promptTokens: 100,
      completionTokens: 50,
      costCents,
      costUnknown,
      status: 'ok',
      ts: new Date('2026-08-10T12:00:00Z'),
    });

    await handle.db.insert(usageLedger).values([
      row(1, 'vibe-time-billing', classA.id, 'openai/gpt-4o-mini', '10.5'),
      row(2, 'vibe-time-billing', classA.id, 'openai/gpt-4o-mini', '4.5'),
      row(3, 'vibe-time-billing', classB.id, 'digitalocean/kimi-k2.5', '20'),
      row(4, 'vibe-mybooks', classA.id, 'ollama/qwen3', '0'),
      // unpriced: a model with no pricing row — cost is NOT in the totals, but must be counted
      row(5, 'vibe-mybooks', classB.id, 'digitalocean/brand-new', null, true),
      // pre-task-class rejection: no class, no model served — must still appear, not vanish
      row(6, 'vibe-connect', null, null, '0'),
    ]);

    return async () => handle.close();
  });

  it('buckets every row once, so each dimension reproduces the same firm total', async () => {
    const rows = await costBreakdown(handle.db, { firmId });

    const byApp = sumBy(rows, 'app');
    const byClass = sumBy(rows, 'taskClass');
    const byModel = sumBy(rows, 'model');
    const total = rows.reduce((s, r) => s + Number(r.costCents), 0);

    expect(total).toBeCloseTo(35, 6); // 10.5 + 4.5 + 20 + 0 + (unpriced → 0) + 0
    const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
    expect(sum(byApp)).toBeCloseTo(total, 6);
    expect(sum(byClass)).toBeCloseTo(total, 6);
    expect(sum(byModel)).toBeCloseTo(total, 6);

    expect(byApp.get('vibe-time-billing')).toBeCloseTo(35, 6);
    expect(byApp.get('vibe-mybooks')).toBeCloseTo(0, 6);
    expect(byModel.get('openai/gpt-4o-mini')).toBeCloseTo(15, 6); // the two rows collapsed
    expect(byModel.get('digitalocean/kimi-k2.5')).toBeCloseTo(20, 6);

    const requests = rows.reduce((s, r) => s + r.requests, 0);
    expect(requests).toBe(6); // no row dropped by the joins or the COALESCEs
  });

  it('keeps unpriced requests visible instead of letting them read as free', async () => {
    const rows = await costBreakdown(handle.db, { firmId });
    const unpriced = rows.find((r) => r.model === 'digitalocean/brand-new');
    expect(unpriced).toBeDefined();
    expect(unpriced?.requests).toBe(1);
    expect(Number(unpriced?.costCents)).toBe(0); // no cost to sum…
    expect(unpriced?.costUnknownCount).toBe(1); // …but flagged, so the UI can say so
    expect(rows.reduce((s, r) => s + r.costUnknownCount, 0)).toBe(1);
  });

  it('labels missing task class / model rather than dropping the row', async () => {
    const rows = await costBreakdown(handle.db, { firmId });
    const orphan = rows.find((r) => r.app === 'vibe-connect');
    expect(orphan).toMatchObject({ taskClass: '(none)', model: '(none)', requests: 1 });
  });

  it('honors the date filter and returns rows ordered by cost', async () => {
    const outside = await costBreakdown(handle.db, {
      firmId,
      from: new Date('2026-08-11T00:00:00Z'),
    });
    expect(outside).toHaveLength(0);

    const inside = await costBreakdown(handle.db, {
      firmId,
      from: new Date('2026-08-10T00:00:00Z'),
      to: new Date('2026-08-10T23:59:59Z'),
    });
    expect(inside.length).toBeGreaterThan(0);
    const costs = inside.map((r) => Number(r.costCents));
    expect([...costs].sort((a, b) => b - a)).toEqual(costs); // already cost-descending
  });
});
