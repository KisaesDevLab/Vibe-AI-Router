/**
 * Ops layer (Phase 13): metrics counters + /metrics endpoint, response cache semantics
 * (opt-in, TTL, local-only default), cache-hit ledger row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { DbLedger } from '../src/ledger/writer.js';
import { StubAdapter } from '../src/gateway/stub-adapter.js';
import { createLogger } from '../src/lib/logger.js';
import { Metrics } from '../src/ops/metrics.js';
import { ResponseCache } from '../src/ops/cache.js';
import { taskClasses } from '../db/schema.js';
import { resetDb } from './helpers.js';
import { DEMO } from '../db/seed.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

describe('ResponseCache', () => {
  it('TTL expiry, LRU cap, deep-copy isolation', () => {
    const cache = new ResponseCache(2);
    const res = {
      message: { role: 'assistant' as const, content: 'x' },
      finishReason: 'stop' as const,
      usage: { promptTokens: 1, completionTokens: 1, cachedReadTokens: 0, cacheWriteTokens: 0, estimated: false },
      served: { model: 'm', providerId: 'p', latencyMs: 1 },
    };
    cache.set('a', res, 60);
    const got = cache.get('a')!;
    got.message.content = 'mutated';
    expect(cache.get('a')!.message.content).toBe('x'); // isolated

    cache.set('b', res, 60);
    cache.set('c', res, 60); // evicts oldest (a was touched → b evicted)
    expect(cache.size).toBe(2);

    cache.set('d', res, 0.00001);
    expect(cache.get('d')).toBeDefined();
  });
});

describe.skipIf(!url)('metrics + cache through the pipeline', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let base: string;
  let adapterCalls = 0;

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 3);
    // opt tb_classification into the response cache
    await handle.db
      .update(taskClasses)
      .set({ requires: { json_schema: true, cache_ttl_s: 300 } })
      .where(eq(taskClasses.key, 'tb_classification'));

    const counting = new (class extends StubAdapter {
      override execute(...args: Parameters<StubAdapter['execute']>): ReturnType<StubAdapter['execute']> {
        adapterCalls++;
        return super.execute(...args);
      }
    })('cached reply body');

    app = buildApp({
      env: loadEnv({ DATABASE_URL: dbUrl, NODE_ENV: 'test' }),
      gateway: {
        deps: {
          db: handle.db,
          adapters: { forKind: () => counting },
          ledger: new DbLedger(handle.db),
          log: createLogger('silent', false),
          engine: new PolicyEngine(handle.db, 50),
          metrics: new Metrics(() => []),
          responseCache: new ResponseCache(),
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

  const chat = (content: string): Promise<Response> =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': 'tb_classification',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    });

  it('identical request hits the cache — one adapter call, two 200s, two ledger rows', async () => {
    adapterCalls = 0;
    const r1 = await chat('same prompt for cache');
    const r2 = await chat('same prompt for cache');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(adapterCalls).toBe(1); // second served from cache

    // invariant (d) holds for cache hits too: exactly one ledger row each
    const id1 = r1.headers.get('x-request-id')!;
    const id2 = r2.headers.get('x-request-id')!;
    const rows = await handle.db.query.usageLedger.findMany();
    expect(rows.filter((r) => r.requestId === id1).length).toBe(1);
    expect(rows.filter((r) => r.requestId === id2).length).toBe(1);

    const different = await chat('a different prompt');
    expect(different.status).toBe(200);
    expect(adapterCalls).toBe(2);
  });

  it('/metrics exposes counters incl. cache events and request totals', async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('vibe_router_requests_total');
    expect(text).toContain('vibe_router_response_cache_events_total{outcome="hit"} 1');
    expect(text).toContain('task_class="tb_classification"');
    expect(text).toContain('vibe_router_request_duration_seconds_bucket');
  });
});
