/**
 * QA Round B (adversarial): fuzzing of every untrusted-input parser + regression tests for
 * the five sweep findings (QA-REPORT.md). Apps are NOT in scope — router only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createServer, type Server } from 'node:http';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { toEnvelope } from '../src/gateway/envelope.js';
import { RouterError } from '../src/gateway/errors.js';
import { translateStreamChunk, translateResponse } from '../src/adapters/openai-compat/translate.js';
import { parseStreamEvent } from '../src/adapters/anthropic/translate.js';
import { redactText, scanText } from '../src/protect/scrub.js';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { DbLedger } from '../src/ledger/writer.js';
import { recordSpend } from '../src/ledger/budget.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { CircuitBreaker } from '../src/resilience/breaker.js';
import { LoadShedGuard } from '../src/resilience/shed.js';
import { ResponseCache } from '../src/ops/cache.js';
import { createLogger } from '../src/lib/logger.js';
import { savePolicy } from '../src/policy/save.js';
import { firms, providers, taskClasses, usageLedger } from '../db/schema.js';
import { resetDb } from './helpers.js';
import { DEMO } from '../db/seed.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];
const META = { app: 'qa' };
const LIMITS = { maxMessages: 50, maxJsonDepth: 12 };

// ── fuzzing: parsers must never crash with anything but RouterError ─────────

describe('fuzz: toEnvelope on arbitrary JSON', () => {
  it('returns a valid envelope or throws RouterError — never TypeError/RangeError', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 8 }), (raw) => {
        try {
          const env = toEnvelope(raw, 'qa_class', META, LIMITS);
          return env.taskClass === 'qa_class' && Array.isArray(env.messages);
        } catch (err) {
          return err instanceof RouterError;
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('survives adversarial message shapes (nulls, weird roles, mixed parts)', () => {
    const partArb = fc.oneof(
      fc.record({ type: fc.constant('text'), text: fc.string() }),
      fc.record({ type: fc.constant('image_url'), image_url: fc.record({ url: fc.string() }) }),
      fc.jsonValue({ maxDepth: 3 }),
    );
    const msgArb = fc.record(
      {
        role: fc.oneof(fc.constantFrom('system', 'user', 'assistant', 'tool', 'developer'), fc.string()),
        content: fc.oneof(fc.string(), fc.constant(null), fc.array(partArb, { maxLength: 4 })),
        tool_call_id: fc.option(fc.string(), { nil: undefined }),
      },
      { requiredKeys: ['role'] },
    );
    fc.assert(
      fc.property(fc.array(msgArb, { minLength: 1, maxLength: 6 }), (messages) => {
        try {
          toEnvelope({ messages }, 'k', META, LIMITS);
          return true;
        } catch (err) {
          return err instanceof RouterError;
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('fuzz: adapter chunk/response translators tolerate arbitrary provider bytes', () => {
  it('openai-compat translateStreamChunk never throws; returns an array', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6 }), (raw) => Array.isArray(translateStreamChunk(raw))),
      { numRuns: 1000 },
    );
  });

  it('openai-compat translateResponse throws RouterError only', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6 }), (raw) => {
        try {
          translateResponse(raw, { model: 'm', providerId: 'p', latencyMs: 1 });
          return true;
        } catch (err) {
          return err instanceof RouterError;
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('anthropic parseStreamEvent returns event or undefined, never throws', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6 }), (raw) => {
        const out = parseStreamEvent(raw);
        return out === undefined || typeof out === 'object';
      }),
      { numRuns: 1000 },
    );
  });
});

describe('fuzz: scrubber redaction is idempotent and total', () => {
  it('redact(redact(x)) === redact(x) for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        const once = redactText(text, scanText(text));
        const twice = redactText(once, scanText(once));
        return once === twice;
      }),
      { numRuns: 1000 },
    );
  });

  it('digit-heavy adversarial strings: scan never throws, spans are sane', () => {
    const digitSoup = fc.stringMatching(/^[0-9 \-.x]{0,300}$/);
    fc.assert(
      fc.property(digitSoup, (text) => {
        const matches = scanText(text);
        return matches.every((m) => m.start >= 0 && m.end <= text.length && m.end > m.start);
      }),
      { numRuns: 1000 },
    );
  });
});

// ── regressions for the Round B sweep findings ──────────────────────────────

describe.skipIf(!url)('QA-B finding regressions (DB)', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let base: string;
  let shed: LoadShedGuard;
  let slowMock: Server;
  let firmId: string;
  let engine: PolicyEngine;

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 5);
    engine = new PolicyEngine(handle.db, 50);
    firmId = (await handle.db.query.firms.findFirst())!.id;

    // slow-streaming mock provider (also answers non-streaming)
    slowMock = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { stream?: boolean };
        if (parsed.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"chunk-one "},"finish_reason":null}]}\n\n');
          let n = 0;
          const timer = setInterval(() => {
            n++;
            if (res.destroyed) return clearInterval(timer);
            res.write(`data: {"choices":[{"delta":{"content":"c${n} "},"finish_reason":null}]}\n\n`);
            if (n > 100) {
              clearInterval(timer);
              res.end('data: [DONE]\n\n');
            }
          }, 25);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            '{"choices":[{"message":{"content":"non-stream reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
          );
        }
      });
    });
    await new Promise<void>((r) => slowMock.listen(0, '127.0.0.1', r));
    const mockAddr = slowMock.address();
    const mockPort = typeof mockAddr === 'object' && mockAddr ? mockAddr.port : 0;
    await handle.db
      .update(providers)
      .set({ baseUrl: `http://127.0.0.1:${mockPort}/v1` })
      .where(eq(providers.kind, 'local'));
    // keyless "cloud" provider on the same mock for the cache_cloud test
    await handle.db.insert(providers).values({
      firmId,
      kind: 'openai_compat',
      label: 'QA Cloud (mock)',
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      authType: 'none',
    });
    // opt tb_research_summary into cloud caching with a PRICED model (finding #2 scenario)
    await handle.db
      .update(taskClasses)
      .set({ requires: { cache_ttl_s: 300, cache_cloud: true } })
      .where(eq(taskClasses.key, 'tb_research_summary'));
    await savePolicy(handle.db, engine, {
      firmId,
      taskClassKey: 'tb_research_summary',
      defaultModelCanonicalId: 'openai/gpt-4o-mini',
      allowedModelCanonicalIds: ['openai/gpt-4o-mini'],
    });

    shed = new LoadShedGuard(4, 4);
    app = buildApp({
      env: loadEnv({ DATABASE_URL: dbUrl, NODE_ENV: 'test' }),
      gateway: {
        deps: {
          db: handle.db,
          adapters: createAdapterRegistry(),
          ledger: new DbLedger(handle.db),
          log: createLogger('silent', false),
          engine,
          ssrfDenyPrivateCloud: false,
          responseCache: new ResponseCache(),
          resilience: {
            breaker: new CircuitBreaker(),
            shed,
            totalTimeoutMs: 20_000,
            streamIdleTimeoutMs: 5_000,
          },
        },
        heartbeatMs: 60_000,
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app?.close();
    slowMock?.close();
    await handle?.close();
  });

  const chat = (taskClass: string, content: string, stream = false): Promise<Response> =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': taskClass,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content }], stream }),
    });

  it('#1: budget soft warning header present on STREAMING responses', async () => {
    await handle.db
      .update(firms)
      .set({ settings: { scrubber_mode: 'redact', budgets: { firm_monthly_cents: 100 } } })
      .where(eq(firms.id, firmId));
    await recordSpend(handle.db, { firmId, app: 'qa', costCents: 85 });
    await new Promise((r) => setTimeout(r, 80)); // engine caches

    const res = await chat('tb_classification', 'stream with warning', true);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-vibe-budget-warning')).toMatch(/firm:/);
    await res.body?.cancel();

    // reset budgets
    await handle.db
      .update(firms)
      .set({ settings: { scrubber_mode: 'redact' } })
      .where(eq(firms.id, firmId));
    const { budgetsState } = await import('../db/schema.js');
    await handle.db.delete(budgetsState);
    await new Promise((r) => setTimeout(r, 80));
  });

  it('#2: cache-hit ledger rows carry ZERO usage and cost (no phantom billing)', async () => {
    const r1 = await chat('tb_research_summary', 'cache me twice');
    const r2 = await chat('tb_research_summary', 'cache me twice');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const row1 = await handle.db.query.usageLedger.findFirst({
      where: eq(usageLedger.requestId, r1.headers.get('x-request-id')!),
    });
    const row2 = await handle.db.query.usageLedger.findFirst({
      where: eq(usageLedger.requestId, r2.headers.get('x-request-id')!),
    });
    // first request: real provider call, real cost (gpt-4o-mini is priced)
    expect(row1!.promptTokens).toBeGreaterThan(0);
    expect(Number(row1!.costCents)).toBeGreaterThan(0);
    // second request: served from cache — zero tokens, zero cost, still exactly one row
    expect(row2!.status).toBe('ok');
    expect(row2!.promptTokens).toBe(0);
    expect(row2!.completionTokens).toBe(0);
    expect(Number(row2!.costCents)).toBe(0);
  });

  it('#3: client abort right after first chunk releases the shed slot (no leak)', async () => {
    const abort = new AbortController();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': 'tb_classification',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'leak check' }], stream: true }),
      signal: abort.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // first chunk delivered — generator suspended mid-hop
    abort.abort();

    // slot must return within a beat; poll up to 2s
    const providerRow = await handle.db.query.providers.findFirst({
      where: (p, { eq: eq_ }) => eq_(p.kind, 'local'),
    });
    let released = false;
    for (let i = 0; i < 40; i++) {
      if (shed.stats(providerRow!.id).inFlight === 0) {
        released = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(released).toBe(true);
  });
});
