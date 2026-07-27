/**
 * Resilience (Phase 10): unit tests for backoff/breaker/limiter/shed + chaos suite (10.8)
 * driving the full pipeline with a fault-injecting provider: 5xx, timeouts, malformed chunks,
 * mid-stream death. Asserts fallback, breaker, and ledger behavior.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { savePolicy } from '../src/policy/save.js';
import { DbLedger } from '../src/ledger/writer.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { CircuitBreaker } from '../src/resilience/breaker.js';
import { LoadShedGuard } from '../src/resilience/shed.js';
import { RateLimiter } from '../src/resilience/limiter.js';
import { retryDelayMs } from '../src/resilience/backoff.js';
import { createLogger } from '../src/lib/logger.js';
import { writeAudit, type AuditEntry } from '../src/protect/audit.js';
import { providers, usageLedger } from '../db/schema.js';
import { resetDb } from './helpers.js';
import { DEMO } from '../db/seed.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

// ── unit: primitives ─────────────────────────────────────────────────────────

describe('backoff (10.1)', () => {
  it('exponential with jitter, Retry-After wins, capped', () => {
    expect(retryDelayMs(0, undefined, () => 0)).toBe(250);
    expect(retryDelayMs(1, undefined, () => 0)).toBe(500);
    expect(retryDelayMs(1, undefined, () => 1)).toBe(750);
    expect(retryDelayMs(5, undefined, () => 0)).toBe(4000); // cap
    expect(retryDelayMs(0, 7)).toBe(7000); // Retry-After respected
    expect(retryDelayMs(0, 9999)).toBe(30_000); // Retry-After capped
  });
});

describe('circuit breaker (10.2)', () => {
  it('opens at threshold, half-open probe, closes on success', () => {
    const b = new CircuitBreaker({ minSamples: 4, openThreshold: 0.5, openDurationMs: 1000 });
    const transitions: string[] = [];
    b.onTransition = (_p, from, to) => transitions.push(`${from}→${to}`);

    let now = 0;
    for (let i = 0; i < 4; i++) b.record('p1', false, now++);
    expect(b.state('p1')).toBe('open');
    expect(b.allow('p1', now)).toBe(false); // still open

    now += 1001; // open window elapsed → half-open admits exactly one probe
    expect(b.allow('p1', now)).toBe(true);
    expect(b.allow('p1', now)).toBe(false);

    b.record('p1', true, now);
    expect(b.state('p1')).toBe('closed');
    expect(transitions).toEqual(['closed→open', 'open→half_open', 'half_open→closed']);
  });

  it('half-open failure re-opens', () => {
    const b = new CircuitBreaker({ minSamples: 2, openThreshold: 0.5, openDurationMs: 100 });
    b.record('p', false, 0);
    b.record('p', false, 1);
    expect(b.state('p')).toBe('open');
    expect(b.allow('p', 200)).toBe(true); // probe
    b.record('p', false, 201);
    expect(b.state('p')).toBe('open');
  });
});

describe('rate limiter (10.6)', () => {
  it('burst then throttle with sane retry-after; refills over time', () => {
    const l = new RateLimiter(60, 5); // 1/s sustained, burst 5
    let now = 0;
    for (let i = 0; i < 5; i++) expect(l.take('k', now)).toBeUndefined();
    const wait = l.take('k', now);
    expect(wait).toBeGreaterThanOrEqual(1);
    now += 2000; // 2 tokens refilled
    expect(l.take('k', now)).toBeUndefined();
    expect(l.take('k', now)).toBeUndefined();
    expect(l.take('k', now)).toBeGreaterThanOrEqual(1);
  });
  it('0 rpm disables', () => {
    const l = new RateLimiter(0);
    for (let i = 0; i < 100; i++) expect(l.take('k')).toBeUndefined();
  });
});

describe('load shed (10.7)', () => {
  it('admits to capacity, queues to cap, sheds beyond', async () => {
    const g = new LoadShedGuard(2, 1);
    const r1 = await g.acquire('p');
    const r2 = await g.acquire('p');
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    const queued = g.acquire('p'); // sits in queue
    const shed = await g.acquire('p'); // queue full → shed
    expect(shed).toBeNull();
    r1!();
    const r3 = await queued;
    expect(r3).not.toBeNull();
    expect(g.stats('p').inFlight).toBe(2);
    r2!();
    r3!();
  });
});

// ── chaos suite (10.8) ───────────────────────────────────────────────────────

type Behavior = 'ok' | 'fail500' | 'fail429' | 'malformed-chunks' | 'die-mid-stream' | 'hang';

describe.skipIf(!url)('chaos: fault-injecting provider through the full pipeline', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let base: string;
  let chaosServer: Server;
  let behavior: Behavior = 'ok';
  let hits = 0;
  let engine: PolicyEngine;
  let breaker: CircuitBreaker;
  const audits: AuditEntry[] = [];

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 5);
    engine = new PolicyEngine(handle.db, 50);
    const firmId = (await handle.db.query.firms.findFirst())!.id;

    // chaos upstream speaking the OpenAI dialect
    chaosServer = createServer((req, res) => {
      hits++;
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { stream?: boolean };
        switch (behavior) {
          case 'ok':
            if (parsed.stream) {
              res.writeHead(200, { 'content-type': 'text/event-stream' });
              res.end(
                'data: {"choices":[{"delta":{"content":"chaos ok"},"finish_reason":null}]}\n\n' +
                  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
                  'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
              );
            } else {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  choices: [{ message: { content: 'chaos ok' }, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 2, completion_tokens: 2 },
                }),
              );
            }
            break;
          case 'fail500':
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end('{"error":{"message":"internal"}}');
            break;
          case 'fail429':
            res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' });
            res.end('{"error":{"message":"slow down"}}');
            break;
          case 'malformed-chunks':
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(
              'data: not-even-json\n\n' +
                'data: {"totally":"unrelated"}\n\n' +
                'data: {"choices":[{"delta":{"content":"survived"},"finish_reason":null}]}\n\n' +
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            );
            break;
          case 'die-mid-stream':
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: {"choices":[{"delta":{"content":"first"},"finish_reason":null}]}\n\n');
            setTimeout(() => res.destroy(), 30); // connection death, no finish
            break;
          case 'hang':
            // accept and never respond — total-timeout territory
            break;
        }
      });
    });
    await new Promise<void>((r) => chaosServer.listen(0, '127.0.0.1', r));
    const chaosAddr = chaosServer.address();
    const chaosPort = typeof chaosAddr === 'object' && chaosAddr ? chaosAddr.port : 0;

    // cloud provider → chaos server; local provider (seed) serves fallbacks via stub? No —
    // fallback target is the local model through the REAL local adapter, which would need a
    // real Ollama. Point the local provider at the chaos server too (it answers ok when the
    // behavior for the fallback leg is ok — we control legs by toggling behavior per test).
    await handle.db.insert(providers).values({
      firmId,
      kind: 'openai_compat',
      label: 'Chaos Cloud',
      baseUrl: `http://127.0.0.1:${chaosPort}/v1`,
      authType: 'none',
    });
    await handle.db
      .update(providers)
      .set({ baseUrl: `http://127.0.0.1:${chaosPort}/v1` })
      .where(eq(providers.kind, 'local'));

    // policy: cloud primary, LOCAL fallback (sensitivity cloud_allowed permits both)
    await savePolicy(handle.db, engine, {
      firmId,
      taskClassKey: 'tb_research_summary',
      defaultModelCanonicalId: 'openai/gpt-4o-mini',
      allowedModelCanonicalIds: ['openai/gpt-4o-mini'],
      fallbackChainCanonicalIds: ['ollama/qwen3:14b'],
    });

    breaker = new CircuitBreaker({ minSamples: 4, openThreshold: 0.5, openDurationMs: 60_000 });
    app = buildApp({
      env: loadEnv({ DATABASE_URL: dbUrl, NODE_ENV: 'test' }),
      gateway: {
        deps: {
          db: handle.db,
          adapters: createAdapterRegistry(), // REAL adapters against the chaos server
          ledger: new DbLedger(handle.db),
          log: createLogger('silent', false),
          engine,
          audit: (entry) => {
            audits.push(entry);
            void writeAudit(handle.db, entry).catch(() => {});
          },
          resilience: {
            breaker,
            shed: new LoadShedGuard(8, 8),
            totalTimeoutMs: 3_000,
            streamIdleTimeoutMs: 500,
          },
          rateLimits: { perToken: new RateLimiter(0), perUser: new RateLimiter(0) },
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
    chaosServer?.close();
    await handle?.close();
  });

  const chat = (content: string, stream = false): Promise<Response> =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': 'tb_research_summary',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content }], stream }),
    });

  it('happy path through real adapter', async () => {
    behavior = 'ok';
    const res = await chat('hello chaos');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toBe('chaos ok');
  });

  it('429 upstream retried (Retry-After honored) — hits increase by retries', async () => {
    behavior = 'fail429';
    hits = 0;
    const res = await chat('retry me');
    // both hops exhaust retries against the same chaos server → eventually 429/502 surfaced
    expect([429, 502]).toContain(res.status);
    // primary: 1 + 2 retries; fallback hop: same server → ≥6 hits total
    expect(hits).toBeGreaterThanOrEqual(6);
  });

  it('dead primary (500) falls back transparently with audit trail (10.3)', async () => {
    // fresh breaker window: use a new test with behavior toggle mid-flight
    behavior = 'fail500';
    hits = 0;
    audits.length = 0;
    // toggle: after 1 failing hit (500 is non-retryable), flip to ok so the FALLBACK leg succeeds
    const orig = behavior;
    void orig;
    const flipAfterFirst = setInterval(() => {
      if (hits >= 1) {
        behavior = 'ok';
        clearInterval(flipAfterFirst);
      }
    }, 1);
    const res = await chat('fallback please');
    clearInterval(flipAfterFirst);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string };
    expect(body.model).toBe('ollama/qwen3:14b'); // served by the fallback hop
    expect(audits.some((a) => a.event === 'fallback_hop')).toBe(true);

    const ledgerRow = await handle.db.query.usageLedger.findFirst({
      where: eq(usageLedger.requestId, res.headers.get('x-request-id')!),
    });
    expect(ledgerRow?.modelServed).toBe('ollama/qwen3:14b');
    expect(ledgerRow?.status).toBe('ok');
  });

  it('malformed stream chunks are tolerated; stream completes (10.8)', async () => {
    breaker.reset(); // isolate from prior chaos legs
    behavior = 'malformed-chunks';
    const res = await chat('garbage in', true);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('survived');
    expect(text).toContain('[DONE]');
  });

  it('mid-stream death after first chunk → clean error event, NO provider splice (10.4)', async () => {
    breaker.reset();
    behavior = 'die-mid-stream';
    const res = await chat('die on me', true);
    expect(res.status).toBe(200); // headers were already sent
    const text = await res.text();
    expect(text).toContain('first'); // the delivered chunk
    expect(text).toContain('"code"'); // terminal error event
    expect(text).toContain('[DONE]');
    expect(text).not.toContain('chaos ok'); // never spliced to another provider
  });

  it('hung upstream trips the total timeout; ledger row still written exactly once', async () => {
    breaker.reset();
    behavior = 'hang';
    const before = (await handle.db.query.usageLedger.findMany()).length;
    const t0 = Date.now();
    const res = await chat('hang forever');
    expect(Date.now() - t0).toBeLessThan(10_000); // 3s budget × hops, not forever
    expect([502, 500]).toContain(res.status);
    const after = await handle.db.query.usageLedger.findMany();
    expect(after.length).toBe(before + 1);
  }, 20_000);

  it('breaker opens under sustained failure and short-circuits without upstream hits', async () => {
    breaker.reset();
    behavior = 'fail500';
    // drive failures to open the breaker on both providers
    for (let i = 0; i < 4; i++) await chat(`open it ${i}`);
    const snapshot = breaker.snapshot();
    expect(snapshot.some((s) => s.state === 'open')).toBe(true);

    hits = 0;
    const res = await chat('should short-circuit');
    expect(res.status).toBe(502);
    expect(hits).toBe(0); // no upstream call — breaker short-circuited every hop
  }, 20_000);
});
