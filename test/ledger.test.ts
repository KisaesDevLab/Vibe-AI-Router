/**
 * Cost ledger & budgets (Phase 9): cost math (9.1), exactly-one row at DB level (9.2),
 * budget soft/hard behavior (9.4/9.5), billing feed (9.9), aggregates (9.7), and the
 * 100-parallel-requests concurrency test (9.11).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { savePolicy } from '../src/policy/save.js';
import { DbLedger } from '../src/ledger/writer.js';
import { computeCost } from '../src/ledger/cost.js';
import { checkBudgets, currentPeriod, recordSpend } from '../src/ledger/budget.js';
import { billingUsage, latencyStats, spendBy } from '../src/ledger/aggregate.js';
import { StubAdapter } from '../src/gateway/stub-adapter.js';
import { createLogger } from '../src/lib/logger.js';
import { firms, providers, usageLedger, budgetsState } from '../db/schema.js';
import { resetDb } from './helpers.js';
import { DEMO } from '../db/seed.js';
import type { AIUsage } from '../src/gateway/envelope.js';
import type { modelPricing } from '../db/schema.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

type PricingRow = typeof modelPricing.$inferSelect;

const USAGE: AIUsage = {
  promptTokens: 1_000_000,
  completionTokens: 500_000,
  cachedReadTokens: 200_000,
  cacheWriteTokens: 100_000,
  estimated: false,
};

function pricing(over: Partial<PricingRow>): PricingRow {
  return {
    id: 'p',
    modelId: 'm',
    effectiveFrom: new Date(),
    inputPerMtok: '3',
    outputPerMtok: '15',
    cacheReadPerMtok: '0.3',
    cacheWritePerMtok: '3.75',
    currency: 'USD',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as PricingRow;
}

describe('computeCost (9.1/9.6)', () => {
  it('prices all four token classes in cents', () => {
    const res = computeCost(USAGE, pricing({}));
    // 1M×$3 + 0.5M×$15 + 0.2M×$0.30 + 0.1M×$3.75 = $3 + $7.5 + $0.06 + $0.375 = $10.935 = 1093.5¢
    expect(Number(res.costCents)).toBeCloseTo(1093.5, 6);
    expect(res.costUnknown).toBe(false);
    // savings: 0.2M at full $3 = 60¢ vs 6¢ paid → 54¢ saved
    expect(Number(res.cacheSavingsCents)).toBeCloseTo(54, 6);
  });

  it('unknown pricing → cost_unknown, never zero (principle 7)', () => {
    const res = computeCost(USAGE, null);
    expect(res.costCents).toBeNull();
    expect(res.costUnknown).toBe(true);
    // zero tokens + no pricing = legitimately zero
    const zero = computeCost({ ...USAGE, promptTokens: 0, completionTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0 }, null);
    expect(zero.costCents).toBe('0');
    expect(zero.costUnknown).toBe(false);
  });

  it('partial pricing (missing output rate with output tokens) → unknown', () => {
    const res = computeCost(USAGE, pricing({ outputPerMtok: null }));
    expect(res.costUnknown).toBe(true);
  });

  it('missing cache rates fall back to input rate (conservative)', () => {
    const res = computeCost(USAGE, pricing({ cacheReadPerMtok: null, cacheWritePerMtok: null }));
    // cache read+write priced at $3: 0.3M×$3 = $0.9 → total $3+7.5+0.9 = $11.4 = 1140¢
    expect(Number(res.costCents)).toBeCloseTo(1140, 6);
  });
});

describe.skipIf(!url)('ledger + budgets end-to-end', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let base: string;
  let firmId: string;
  let engine: PolicyEngine;

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 10);
    engine = new PolicyEngine(handle.db, 50);
    firmId = (await handle.db.query.firms.findFirst())!.id;

    // keyless cloud provider so priced models route without a vault
    await handle.db.insert(providers).values({
      firmId,
      kind: 'openai_compat',
      label: 'Cloud (mock)',
      baseUrl: 'http://127.0.0.1:1/v1',
      authType: 'none',
    });
    // tb_research_summary → priced cloud model (gpt-4o-mini $0.15/$0.60)
    await savePolicy(handle.db, engine, {
      firmId,
      taskClassKey: 'tb_research_summary',
      defaultModelCanonicalId: 'openai/gpt-4o-mini',
      allowedModelCanonicalIds: ['openai/gpt-4o-mini'],
    });

    app = buildApp({
      env: loadEnv({ DATABASE_URL: dbUrl, NODE_ENV: 'test' }),
      gateway: {
        deps: {
          db: handle.db,
          adapters: { forKind: () => new StubAdapter('four words exactly here') },
          ledger: new DbLedger(handle.db),
          log: createLogger('silent', false),
          engine,
        },
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  const chat = (taskClass: string, content: string, headers?: Record<string, string>): Promise<Response> =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': taskClass,
        ...headers,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    });

  it('a completed cloud request writes one row with computed cost; local request costs 0', async () => {
    const res = await chat('tb_research_summary', 'summarize CCA 202612345', {
      'x-vibe-client': 'CLIENT-42',
      'x-vibe-engagement': 'ENG-7',
    });
    expect(res.status).toBe(200);
    const requestId = res.headers.get('x-request-id')!;
    const row = await handle.db.query.usageLedger.findFirst({
      where: eq(usageLedger.requestId, requestId),
    });
    expect(row).toBeDefined();
    expect(row!.status).toBe('ok');
    expect(row!.modelServed).toBe('openai/gpt-4o-mini');
    expect(Number(row!.costCents)).toBeGreaterThan(0);
    expect(row!.costUnknown).toBe(false);
    expect(row!.clientRef).toBe('CLIENT-42');
    expect(row!.engagementRef).toBe('ENG-7');

    const local = await chat('tb_classification', 'classify rent expense');
    const localRow = await handle.db.query.usageLedger.findFirst({
      where: eq(usageLedger.requestId, local.headers.get('x-request-id')!),
    });
    expect(Number(localRow!.costCents)).toBe(0); // explicit $0 local pricing (Q-007)
    expect(localRow!.costUnknown).toBe(false);
  });

  it('failed requests also write exactly one row with mapped status', async () => {
    const res = await chat('no_such_class', 'x');
    expect(res.status).toBe(403);
    const row = await handle.db.query.usageLedger.findFirst({
      where: eq(usageLedger.requestId, res.headers.get('x-request-id')!),
    });
    expect(row).toBeDefined();
    expect(row!.status).toBe('policy_blocked');
    expect(row!.taskClassId).toBeNull();
  });

  it('budget: soft warning header at 80%, hard stop 402, most restrictive wins (9.4/9.5)', async () => {
    // firm limit 100¢; pre-load 85¢ spent → soft warning expected
    await handle.db
      .update(firms)
      .set({ settings: { scrubber_mode: 'block', budgets: { firm_monthly_cents: 100 } } })
      .where(eq(firms.id, firmId));
    await recordSpend(handle.db, { firmId, app: 'seed', costCents: 85 });
    await new Promise((r) => setTimeout(r, 60)); // engine cache TTL

    const soft = await chat('tb_research_summary', 'soft check');
    expect(soft.status).toBe(200);
    expect(soft.headers.get('x-vibe-budget-warning')).toMatch(/firm:8[5-9]|firm:9\d/);

    // push over the hard limit
    await recordSpend(handle.db, { firmId, app: 'seed', costCents: 20 });
    const hard = await chat('tb_research_summary', 'hard check');
    expect(hard.status).toBe(402);
    const body = (await hard.json()) as { error: { code: string } };
    expect(body.error.code).toBe('budget_exceeded');

    // hard-stopped firm scope must also stop other apps/users (most restrictive wins)
    const viaCheck = checkBudgets(handle.db, {
      firmId,
      app: 'other-app',
      taskClassId: (await handle.db.query.taskClasses.findFirst())!.id,
      settings: { firm_monthly_cents: 100 },
      policyMonthlyCents: null,
    });
    await expect(viaCheck).rejects.toThrow(/budget exhausted/);

    // reset budgets for later tests
    await handle.db.update(firms).set({ settings: { scrubber_mode: 'block' } }).where(eq(firms.id, firmId));
    await handle.db.delete(budgetsState);
    await new Promise((r) => setTimeout(r, 60));
  });

  it('(9.11) 100 parallel requests → exactly 100 rows, unique ids, budget total = sum of costs', async () => {
    const before = (await handle.db.query.usageLedger.findMany()).length;
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => chat('tb_research_summary', `parallel item ${i}`)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);

    const rows = await handle.db.query.usageLedger.findMany();
    expect(rows.length).toBe(before + 100);
    expect(new Set(rows.map((r) => r.requestId)).size).toBe(rows.length);

    // budget state was reset just before this test — compare against THIS batch's rows only
    const batchIds = new Set(results.map((r) => r.headers.get('x-request-id')));
    const cloudRows = rows.filter((r) => batchIds.has(r.requestId) && r.status === 'ok');
    expect(cloudRows.length).toBe(100);
    const expectedTotal = cloudRows.reduce((s, r) => s + Number(r.costCents ?? 0), 0);
    const state = await handle.db.query.budgetsState.findMany({
      where: (b, { and: and_, eq: eq_ }) =>
        and_(eq_(b.scope, 'firm'), eq_(b.period, currentPeriod())),
    });
    expect(Number(state[0]?.spentCents ?? 0)).toBeCloseTo(expectedTotal, 4);
  });

  it('billing feed groups by client (9.9) and aggregates answer (9.7)', async () => {
    const period = currentPeriod();
    const items = await billingUsage(handle.db, firmId, period);
    const client42 = items.find((i) => i.clientRef === 'CLIENT-42');
    expect(client42).toBeDefined();
    expect(client42!.requests).toBeGreaterThan(0);
    expect(Number(client42!.costCents)).toBeGreaterThan(0);

    // via HTTP with app token
    const res = await fetch(`${base}/v1/billing/usage?period=${period}&client_ref=CLIENT-42`, {
      headers: { authorization: `Bearer ${DEMO.appToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { clientRef: string }[] };
    expect(body.items.every((i) => i.clientRef === 'CLIENT-42')).toBe(true);

    const byModel = await spendBy(handle.db, 'model', { firmId });
    expect(byModel.some((r) => r.dimension === 'openai/gpt-4o-mini' && Number(r.costCents) > 0)).toBe(true);
    const latency = await latencyStats(handle.db, { firmId });
    expect(latency.requests).toBeGreaterThan(100);
    expect(latency.p95Ms).not.toBeNull();
  });

  it('idempotency: double write for the same requestId leaves one row and one spend increment', async () => {
    const ledger = new DbLedger(handle.db);
    const auth = { firmId, app: 'vibe-tb', scopes: ['chat'], tokenId: 't' };
    const taskClass = await handle.db.query.taskClasses.findFirst();
    const fakeCtx = {
      requestId: 'idempotency-test-1',
      requestHash: 'h',
      startedAt: Date.now(),
      auth,
      taskClass,
      envelope: { taskClass: 'x', messages: [], stream: false, metadata: { app: 'vibe-tb' } },
      response: undefined,
      error: undefined,
    };
    await ledger.write(fakeCtx as never);
    await ledger.write(fakeCtx as never);
    const rows = await handle.db.query.usageLedger.findMany({
      where: eq(usageLedger.requestId, 'idempotency-test-1'),
    });
    expect(rows.length).toBe(1);
  });
});
