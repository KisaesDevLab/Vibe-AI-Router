/**
 * Client-disconnect abort propagation (2.7): killing the HTTP request mid-stream must abort
 * the upstream adapter signal promptly (no orphaned token burn).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { NoopLedger } from '../src/gateway/pipeline.js';
import { PolicyEngine } from '../src/policy/engine.js';
import type { GatewayAdapter } from '../src/gateway/adapter-types.js';
import type { StreamChunk } from '../src/gateway/envelope.js';
import { createLogger } from '../src/lib/logger.js';
import { migrate } from '../db/migrate.js';
import { seed, DEMO } from '../db/seed.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

describe.skipIf(!url)('stream abort propagation', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let port: number;
  let upstreamAborted: (() => void) | undefined;
  const abortObserved = new Promise<void>((resolve) => {
    upstreamAborted = resolve;
  });

  /** Adapter that streams forever until the signal aborts. */
  const slowAdapter: GatewayAdapter = {
    kind: 'slow',
    execute: () => Promise.reject(new Error('not used')),
    async *executeStream(_env, _ctx, signal): AsyncIterable<StreamChunk> {
      signal.addEventListener('abort', () => upstreamAborted?.());
      for (let i = 0; i < 10_000; i++) {
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, 5));
        yield { type: 'text_delta', delta: `t${i} ` };
      }
    },
  };

  beforeAll(async () => {
    const dbUrl = url as string;
    await migrate(dbUrl, 'up');
    await seed(dbUrl);
    handle = createDb(dbUrl, 2);
    app = buildApp({
      env: loadEnv({ DATABASE_URL: dbUrl, NODE_ENV: 'test' }),
      gateway: {
        deps: {
          db: handle.db,
          adapters: { forKind: () => slowAdapter },
          ledger: new NoopLedger(),
          log: createLogger('silent', false),
          engine: new PolicyEngine(handle.db),
        },
        heartbeatMs: 60_000,
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    port = addr.port;
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('aborts upstream within 1s of client disconnect (10.9 pre-check)', async () => {
    const clientAbort = new AbortController();
    const resPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': 'tb_classification',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }], stream: true }),
      signal: clientAbort.signal,
    });

    const res = await resPromise;
    const reader = res.body?.getReader();
    await reader?.read(); // ensure streaming has started
    const t0 = Date.now();
    clientAbort.abort(); // client walks away

    await Promise.race([
      abortObserved,
      new Promise((_r, reject) => setTimeout(() => reject(new Error('upstream not aborted within 2s')), 2000)),
    ]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
