/**
 * Response verification + the redundancy it unlocks.
 *
 * Unit tier: the verdict function and the JSON Schema subset validator.
 * Chaos tier: a provider that is UP and answering 200 with unusable results must be retried,
 * fallen back from, and recorded against its health — never surfaced to the app as a success.
 * Also covers the routing-stage regression: a primary that cannot be routed at all must not
 * bypass the configured fallback chain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createDb, type DbHandle } from '../src/db/client.js';
import { models, providers, usageLedger } from '../db/schema.js';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { DbLedger } from '../src/ledger/writer.js';
import { createLogger } from '../src/lib/logger.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { savePolicy } from '../src/policy/save.js';
import { clampToModel } from '../src/policy/engine.js';
import { CircuitBreaker } from '../src/resilience/breaker.js';
import { LoadShedGuard } from '../src/resilience/shed.js';
import { RateLimiter } from '../src/resilience/limiter.js';
import {
  resolveValidationMode,
  stripFence,
  validateSchemaSubset,
  verifyResponse,
  type SoftFinding,
} from '../src/gateway/verify.js';
import type { AIRequest, AIResponse } from '../src/gateway/envelope.js';
import { EMPTY_USAGE } from '../src/gateway/envelope.js';
import type { AuditEntry } from '../src/protect/audit.js';
import { writeAudit } from '../src/protect/audit.js';
import { resetDb } from './helpers.js';
import { DEMO } from '../db/seed.js';

const url = process.env.VIBE_ROUTER_TEST_DATABASE_URL;

// ── unit: schema subset validator ────────────────────────────────────────────

describe('validateSchemaSubset', () => {
  const schema = {
    type: 'object',
    required: ['vendor', 'total'],
    properties: {
      vendor: { type: 'string' },
      total: { type: 'number' },
      currency: { type: 'string', enum: ['USD', 'EUR'] },
      lines: { type: 'array', items: { type: 'object', required: ['desc'], properties: { desc: { type: 'string' } } } },
    },
  };

  it('accepts a conforming object', () => {
    expect(
      validateSchemaSubset({ vendor: 'Acme', total: 12.5, currency: 'USD', lines: [{ desc: 'x' }] }, schema),
    ).toBeUndefined();
  });

  it('flags a missing required property by path', () => {
    expect(validateSchemaSubset({ vendor: 'Acme' }, schema)?.path).toBe('$.total');
  });

  it('flags a wrong scalar type by path', () => {
    expect(validateSchemaSubset({ vendor: 'Acme', total: '12.50' }, schema)?.path).toBe('$.total');
  });

  it('flags an enum violation (strict mode — no soft collector)', () => {
    const bad = validateSchemaSubset({ vendor: 'A', total: 1, currency: 'GBP' }, schema);
    expect(bad?.path).toBe('$.currency');
  });

  it('STRUCTURAL mode: an enum miss is collected as a soft finding and the value passes', () => {
    const soft: SoftFinding[] = [];
    const bad = validateSchemaSubset({ vendor: 'A', total: 1, currency: 'GBP' }, schema, '$', { soft });
    expect(bad).toBeUndefined();
    expect(soft).toEqual([{ keyword: 'enum', path: '$.currency' }]);
    // the path never carries the value
    expect(JSON.stringify(soft)).not.toContain('GBP');
  });

  it('STRUCTURAL mode keeps required/type/items HARD', () => {
    const soft: SoftFinding[] = [];
    expect(validateSchemaSubset({ vendor: 'A' }, schema, '$', { soft })?.path).toBe('$.total');
    expect(validateSchemaSubset({ vendor: 'A', total: 'x' }, schema, '$', { soft })?.path).toBe('$.total');
    expect(validateSchemaSubset({ vendor: 'A', total: 1, lines: [{}] }, schema, '$', { soft })?.path).toBe(
      '$.lines[0].desc',
    );
    expect(soft).toEqual([]);
  });

  it('anyOf with an ENUM DISCRIMINATOR still discriminates in structural mode (review finding)', () => {
    const s = {
      anyOf: [
        { type: 'object', required: ['kind', 'amount'], properties: { kind: { enum: ['charge'] }, amount: { type: 'number' } } },
        { type: 'object', required: ['kind'], properties: { kind: { enum: ['note'] } } },
      ],
    };
    // a charge missing its amount must NOT be absorbed by the looser `note` branch via a soft
    // enum: the value named its variant, so the `charge` branch's violation is authoritative
    const soft: SoftFinding[] = [];
    expect(validateSchemaSubset({ kind: 'charge' }, s, '$', { soft })?.path).toBe('$.amount');
    expect(soft).toEqual([]);
    // branch order does not matter — the authoritative hard failure wins over an earlier soft match
    const reversed = { anyOf: [s.anyOf[1], s.anyOf[0]] };
    expect(validateSchemaSubset({ kind: 'charge' }, reversed, '$', { soft })?.path).toBe('$.amount');
    expect(soft).toEqual([]);
    // a valid `note` matches strictly on branch 2 — NO spurious soft finding from branch 1
    expect(validateSchemaSubset({ kind: 'note' }, s, '$', { soft })).toBeUndefined();
    expect(soft).toEqual([]);
    // a structurally valid object whose discriminator is an unknown member: soft in structural…
    expect(validateSchemaSubset({ kind: 'refund', amount: 1 }, s, '$', { soft })).toBeUndefined();
    expect(soft).toEqual([{ keyword: 'enum', path: '$.kind' }]);
    // …and a hard miss in strict
    expect(validateSchemaSubset({ kind: 'refund', amount: 1 }, s)?.message).toMatch(/none of the anyOf/);
  });

  it('anyOf: only the PASSING branch contributes soft findings (rejected branches are scratch)', () => {
    const s = {
      anyOf: [
        { type: 'number' }, // fails on type for a string value
        { type: 'string', enum: ['a', 'b'] }, // passes structurally, enum miss is soft
      ],
    };
    const soft: SoftFinding[] = [];
    expect(validateSchemaSubset('zzz', s, '$.k', { soft })).toBeUndefined();
    expect(soft).toEqual([{ keyword: 'enum', path: '$.k' }]);
    // strict: the enum miss makes the second branch fail too → no branch matches
    expect(validateSchemaSubset('zzz', s, '$.k')?.message).toMatch(/none of the anyOf/);
  });

  it('descends into array items and reports the index', () => {
    const bad = validateSchemaSubset({ vendor: 'A', total: 1, lines: [{ desc: 'ok' }, { nope: 1 }] }, schema);
    expect(bad?.path).toBe('$.lines[1].desc');
  });

  it('integer vs number is enforced', () => {
    expect(validateSchemaSubset(1.5, { type: 'integer' })).toBeDefined();
    expect(validateSchemaSubset(2, { type: 'integer' })).toBeUndefined();
  });

  it('nullable and union types are honored', () => {
    expect(validateSchemaSubset(null, { type: 'string', nullable: true })).toBeUndefined();
    expect(validateSchemaSubset(null, { type: ['string', 'null'] })).toBeUndefined();
    expect(validateSchemaSubset(null, { type: 'string' })).toBeDefined();
  });

  it('anyOf passes when any branch matches', () => {
    const s = { anyOf: [{ type: 'string' }, { type: 'number' }] };
    expect(validateSchemaSubset('x', s)).toBeUndefined();
    expect(validateSchemaSubset(3, s)).toBeUndefined();
    expect(validateSchemaSubset(true, s)).toBeDefined();
  });

  it('UNSUPPORTED keywords never manufacture a failure (fault detector, not a gate)', () => {
    // $ref / allOf / minLength / additionalProperties are ignored by design
    expect(validateSchemaSubset({ a: 'x' }, { $ref: '#/defs/Thing' })).toBeUndefined();
    expect(validateSchemaSubset('ab', { type: 'string', minLength: 99 })).toBeUndefined();
    expect(validateSchemaSubset({ a: 1, b: 2 }, { type: 'object', additionalProperties: false })).toBeUndefined();
  });
});

describe('stripFence', () => {
  it('removes ```json fences and whitespace', () => {
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFence('  {"a":1}  ')).toBe('{"a":1}');
  });
});

// ── unit: verifyResponse ─────────────────────────────────────────────────────

const res = (over: Partial<AIResponse> & { content?: string }): AIResponse => ({
  message: { role: 'assistant', content: over.content ?? 'hello', ...(over.message?.toolCalls ? {} : {}) },
  finishReason: 'stop',
  usage: { ...EMPTY_USAGE, completionTokens: 5 },
  served: { model: 'm', providerId: 'p', latencyMs: 1 },
  ...over,
});

const env = (over: Partial<AIRequest> = {}): AIRequest =>
  ({
    taskClass: 'tc',
    messages: [{ role: 'user', content: 'hi' }],
    ...over,
  }) as AIRequest;

describe('verifyResponse', () => {
  it('accepts an ordinary text completion', () => {
    expect(verifyResponse(res({ content: 'a real answer' }), env())).toBeUndefined();
  });

  it('flags an empty completion with no tool calls', () => {
    expect(verifyResponse(res({ content: '   ' }), env())?.reason).toBe('empty_response');
  });

  it('EXEMPTS a content_filter refusal — a legitimate terminal outcome, not a fault', () => {
    expect(verifyResponse(res({ content: '', finishReason: 'content_filter' }), env())).toBeUndefined();
  });

  it('flags a provider-signalled error finish reason', () => {
    expect(verifyResponse(res({ content: 'x', finishReason: 'error' }), env())?.reason).toBe(
      'provider_error_finish',
    );
  });

  it('flags tool-call arguments that are not JSON', () => {
    const r = res({
      content: '',
      message: { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'f', arguments: '{not json' }] },
    });
    expect(verifyResponse(r, env())?.reason).toBe('tool_arguments_not_json');
  });

  it('does NOT require JSON when the request never asked for it', () => {
    expect(verifyResponse(res({ content: 'plain prose' }), env())).toBeUndefined();
  });

  it('flags prose returned for a forced-JSON request', () => {
    const e = env({ responseFormat: { type: 'json_object' } } as Partial<AIRequest>);
    expect(verifyResponse(res({ content: 'Sure! Here is the data you wanted.' }), e)?.reason).toBe(
      'response_not_json',
    );
  });

  it('accepts fenced JSON for a forced-JSON request', () => {
    const e = env({ responseFormat: { type: 'json_object' } } as Partial<AIRequest>);
    expect(verifyResponse(res({ content: '```json\n{"a":1}\n```' }), e)).toBeUndefined();
  });

  it('reports truncation BEFORE a parse error so the operator chases the right fault', () => {
    const e = env({ responseFormat: { type: 'json_object' } } as Partial<AIRequest>);
    expect(verifyResponse(res({ content: '{"a":1,"b"', finishReason: 'length' }), e)?.reason).toBe('json_truncated');
  });

  it('flags a schema violation and carries the PATH, never the value', () => {
    const e = env({
      responseFormat: {
        type: 'json_schema',
        name: 'Receipt',
        schema: { type: 'object', required: ['vendor', 'total'], properties: { total: { type: 'number' } } },
      },
    } as Partial<AIRequest>);
    const finding = verifyResponse(res({ content: '{"vendor":"Acme","total":"twelve"}' }), e);
    expect(finding?.reason).toBe('schema_violation');
    expect(finding?.path).toBe('$.total');
    expect(JSON.stringify(finding)).not.toContain('twelve');
  });

  it('enum miss: STRUCTURAL by default → passes with a soft finding; strict → schema_violation', () => {
    const schema = { type: 'object', required: ['k'], properties: { k: { type: 'string', enum: ['a', 'b'] } } };
    const body = res({ content: '{"k":"zzz"}' });

    const structural = env({ responseFormat: { type: 'json_schema', name: 'K', schema } } as Partial<AIRequest>);
    const soft: SoftFinding[] = [];
    expect(verifyResponse(body, structural, soft)).toBeUndefined();
    expect(soft).toEqual([{ keyword: 'enum', path: '$.k' }]);
    // and without a collector the verdict is the same (soft findings are simply dropped)
    expect(verifyResponse(body, structural)).toBeUndefined();

    const strict = env({
      responseFormat: { type: 'json_schema', name: 'K', schema, validation: 'strict' },
    } as Partial<AIRequest>);
    const finding = verifyResponse(body, strict, []);
    expect(finding?.reason).toBe('schema_violation');
    expect(finding?.path).toBe('$.k');
    expect(JSON.stringify(finding)).not.toContain('zzz');
  });

  it('validation mode resolution (Q-099): explicit > OpenAI strict hint > deployment default', () => {
    const schema = { type: 'object', required: ['k'], properties: { k: { type: 'string', enum: ['a'] } } };
    const rf = (over: Record<string, unknown>) => ({ type: 'json_schema', name: 'K', schema, ...over }) as AIRequest['responseFormat'];
    expect(resolveValidationMode(rf({}))).toBe('structural');
    expect(resolveValidationMode(rf({}), 'strict')).toBe('strict');
    expect(resolveValidationMode(rf({ strict: true }))).toBe('strict');
    expect(resolveValidationMode(rf({ strict: true, validation: 'structural' }))).toBe('structural');
    expect(resolveValidationMode(rf({ validation: 'strict' }))).toBe('strict');
    expect(resolveValidationMode({ type: 'json_object' }, 'strict')).toBe('strict');

    // an older client that only knows OpenAI's `strict: true` keeps 0.0.24 behaviour
    const body = res({ content: '{"k":"zzz"}' });
    const hinted = env({ responseFormat: rf({ strict: true }) } as Partial<AIRequest>);
    expect(verifyResponse(body, hinted, [])?.reason).toBe('schema_violation');
    // and a deployment can flip the default fleet-wide
    const plain = env({ responseFormat: rf({}) } as Partial<AIRequest>);
    expect(verifyResponse(body, plain, [], 'strict')?.reason).toBe('schema_violation');
    expect(verifyResponse(body, plain, [], 'structural')).toBeUndefined();
  });

  it('accepts a forced-JSON answer delivered as a tool call instead of content', () => {
    const e = env({
      responseFormat: { type: 'json_schema', name: 'R', schema: { type: 'object', required: ['a'] } },
    } as Partial<AIRequest>);
    const r = res({
      content: '',
      message: { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'R', arguments: '{"a":1}' }] },
    });
    expect(verifyResponse(r, e)).toBeUndefined();
  });
});

// ── chaos: redundancy end to end ─────────────────────────────────────────────

type Mode = 'json-ok' | 'prose' | 'empty' | 'empty-stream' | 'schema-miss' | 'enum-miss' | 'truncated';

describe.skipIf(!url)('redundancy: healthy provider, unusable results', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let base: string;
  let primary: Server;
  let secondary: Server;
  let primaryMode: Mode = 'prose';
  let primaryHits = 0;
  /** the max_tokens the PRIMARY upstream actually received on the wire */
  let primaryMaxTokens: number | undefined;
  let secondaryHits = 0;
  const audits: AuditEntry[] = [];

  const jsonBody = (obj: unknown): string =>
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 8 },
    });

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 5);
    const engine = new PolicyEngine(handle.db, 50);
    const firmId = (await handle.db.query.firms.findFirst())!.id;

    // PRIMARY upstream: always 200, always healthy — but the body is unusable
    primary = createServer((req, res2) => {
      primaryHits++;
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsedReq = JSON.parse(body) as { stream?: boolean; max_tokens?: number };
        primaryMaxTokens = parsedReq.max_tokens;
        const streamed = parsedReq.stream === true;
        if (primaryMode === 'empty-stream' || (streamed && primaryMode !== 'json-ok')) {
          // a stream that opens, keeps alive, finishes — and never emits content
          res2.writeHead(200, { 'content-type': 'text/event-stream' });
          res2.end(
            'data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n' +
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          );
          return;
        }
        res2.writeHead(200, { 'content-type': 'application/json' });
        switch (primaryMode) {
          case 'prose':
            res2.end(
              JSON.stringify({
                choices: [{ message: { content: 'Sure! Here is your data.' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 2, completion_tokens: 6 },
              }),
            );
            break;
          case 'empty':
            res2.end(
              JSON.stringify({
                choices: [{ message: { content: '' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 2, completion_tokens: 0 },
              }),
            );
            break;
          case 'schema-miss':
            res2.end(jsonBody({ vendor: 'Acme', total: 'twelve dollars' }));
            break;
          case 'enum-miss':
            // structurally valid, but `currency` is not an enum member (a 397B model inventing a key)
            res2.end(jsonBody({ vendor: 'Acme', total: 12, currency: 'GBP' }));
            break;
          case 'truncated':
            res2.end(
              JSON.stringify({
                choices: [{ message: { content: '{"vendor":"Acme","tot' }, finish_reason: 'length' }],
                usage: { prompt_tokens: 2, completion_tokens: 512 },
              }),
            );
            break;
          default:
            res2.end(jsonBody({ vendor: 'Acme', total: 12 }));
        }
      });
    });
    await new Promise<void>((r) => primary.listen(0, '127.0.0.1', r));

    // SECONDARY upstream (fallback target): always returns a valid, conforming result
    secondary = createServer((req, res2) => {
      secondaryHits++;
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const streamed = (JSON.parse(body) as { stream?: boolean }).stream === true;
        if (streamed) {
          res2.writeHead(200, { 'content-type': 'text/event-stream' });
          res2.end(
            'data: {"choices":[{"delta":{"content":"{\\"vendor\\":\\"Acme\\",\\"total\\":12}"},"finish_reason":null}]}\n\n' +
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          );
          return;
        }
        res2.writeHead(200, { 'content-type': 'application/json' });
        res2.end(jsonBody({ vendor: 'Acme', total: 12 }));
      });
    });
    await new Promise<void>((r) => secondary.listen(0, '127.0.0.1', r));

    const portOf = (s: Server): number => {
      const a = s.address();
      return typeof a === 'object' && a ? a.port : 0;
    };

    // cloud provider → the misbehaving primary; local provider → the good secondary
    await handle.db.insert(providers).values({
      firmId,
      kind: 'openai_compat',
      label: 'Healthy But Wrong',
      baseUrl: `http://127.0.0.1:${portOf(primary)}/v1`,
      authType: 'none',
    });
    await handle.db
      .update(providers)
      .set({ baseUrl: `http://127.0.0.1:${portOf(secondary)}/v1` })
      .where(eq(providers.kind, 'local'));

    await savePolicy(handle.db, engine, {
      firmId,
      taskClassKey: 'tb_research_summary', // cloud_allowed
      defaultModelCanonicalId: 'openai/gpt-4o-mini',
      allowedModelCanonicalIds: ['openai/gpt-4o-mini'],
      fallbackChainCanonicalIds: ['ollama/qwen3:14b'],
    });

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
          audit: (entry) => {
            audits.push(entry);
            void writeAudit(handle.db, entry).catch(() => {});
          },
          resilience: {
            breaker: new CircuitBreaker({ minSamples: 50, openThreshold: 0.99, openDurationMs: 1000 }),
            shed: new LoadShedGuard(8, 8),
            totalTimeoutMs: 5_000,
            streamIdleTimeoutMs: 1_000,
            verifyResponses: true,
          },
          rateLimits: { perToken: new RateLimiter(0), perUser: new RateLimiter(0) },
        },
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const a = app.server.address();
    if (a === null || typeof a === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${a.port}`;
  });

  afterAll(async () => {
    await app?.close();
    primary?.close();
    secondary?.close();
    await handle?.close();
  });

  const chat = (
    opts: { stream?: boolean; json?: boolean; schema?: unknown; validation?: 'structural' | 'strict' } = {},
  ): Promise<Response> =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': 'tb_research_summary',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'extract the receipt' }],
        stream: opts.stream ?? false,
        ...(opts.json
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: 'Receipt',
                  schema: opts.schema ?? {
                    type: 'object',
                    required: ['vendor', 'total'],
                    properties: {
                      vendor: { type: 'string' },
                      total: { type: 'number' },
                      currency: { type: 'string', enum: ['USD', 'EUR'] },
                    },
                  },
                  ...(opts.validation ? { validation: opts.validation } : {}),
                },
              },
            }
          : {}),
      }),
    });

  const reset = (mode: Mode): void => {
    primaryMode = mode;
    primaryHits = 0;
    secondaryHits = 0;
    primaryMaxTokens = undefined;
    audits.length = 0;
  };

  it('prose for a forced-JSON request → retried, then the fallback hop serves', async () => {
    reset('prose');
    const res2 = await chat({ json: true });
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { model: string; choices: { message: { content: string } }[] };
    expect(body.model).toBe('ollama/qwen3:14b'); // fallback served
    expect(JSON.parse(body.choices[0]!.message.content)).toEqual({ vendor: 'Acme', total: 12 });

    // the bad hop was retried on the same model before advancing (1 + MAX_RETRIES)
    expect(primaryHits).toBeGreaterThanOrEqual(3);
    expect(secondaryHits).toBeGreaterThanOrEqual(1);
    expect(audits.some((a) => a.event === 'response_rejected')).toBe(true);
    expect(audits.some((a) => a.event === 'fallback_hop')).toBe(true);
  });

  it('a schema violation is caught even though the body IS valid JSON', async () => {
    reset('schema-miss');
    const res2 = await chat({ json: true });
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { model: string };
    expect(body.model).toBe('ollama/qwen3:14b');
    const rejected = audits.find((a) => a.event === 'response_rejected');
    expect((rejected?.detail as { reason: string }).reason).toBe('schema_violation');
    // path only — the offending value never reaches the audit row
    expect(JSON.stringify(rejected?.detail)).not.toContain('twelve');
  });

  it('an ENUM miss is served under structural validation (default) — audited, counted, not rejected', async () => {
    reset('enum-miss');
    const res2 = await chat({ json: true });
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { model: string; choices: { message: { content: string } }[] };
    // the PRIMARY served: no retry, no fallback walk
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(primaryHits).toBe(1);
    expect(secondaryHits).toBe(0);
    expect(JSON.parse(body.choices[0]!.message.content)).toMatchObject({ vendor: 'Acme', total: 12 });
    expect(audits.some((a) => a.event === 'response_rejected')).toBe(false);
    const soft = audits.find((a) => a.event === 'response_soft_finding');
    expect(soft?.detail).toEqual({ reason: 'schema_enum_miss', count: 1, path: '$.currency' });
    expect(JSON.stringify(soft?.detail)).not.toContain('GBP');
  });

  it('the same ENUM miss under validation: strict is rejected and falls back (today\'s behaviour)', async () => {
    reset('enum-miss');
    const res2 = await chat({ json: true, validation: 'strict' });
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { model: string };
    expect(body.model).toBe('ollama/qwen3:14b');
    expect(secondaryHits).toBeGreaterThanOrEqual(1);
    const rejected = audits.find((a) => a.event === 'response_rejected');
    expect(rejected?.detail).toMatchObject({ reason: 'schema_violation', path: '$.currency' });
    expect(audits.some((a) => a.event === 'response_soft_finding')).toBe(false);
  });

  it('an empty completion falls back even with no response_format at all', async () => {
    reset('empty');
    const res2 = await chat();
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { model: string };
    expect(body.model).toBe('ollama/qwen3:14b');
  });

  it('the ledger records the model that actually served, status ok', async () => {
    reset('prose');
    const res2 = await chat({ json: true });
    const row = await handle.db.query.usageLedger.findFirst({
      where: eq(usageLedger.requestId, res2.headers.get('x-request-id')!),
    });
    expect(row?.modelServed).toBe('ollama/qwen3:14b');
    expect(row?.status).toBe('ok');
  });

  it('STREAMING: a content-free stream falls back before anything reaches the client', async () => {
    reset('empty-stream');
    const res2 = await chat({ stream: true });
    expect(res2.status).toBe(200);
    const text = await res2.text();
    expect(text).toContain('Acme'); // the fallback hop's content, not an empty success
    expect(secondaryHits).toBeGreaterThanOrEqual(1);
  });

  it('the PRIMARY model max_output clamps the wire request, and truncation advances the chain', async () => {
    // gpt-4o-mini can emit 512 here; the class cap (tb_research_summary: 8192) is far above it
    await handle.db.update(models).set({ maxOutput: 512 }).where(eq(models.canonicalId, 'openai/gpt-4o-mini'));
    await new Promise((r) => setTimeout(r, 80)); // let the 50ms policy cache expire
    reset('truncated');

    const res2 = await chat({ json: true });
    expect(res2.status).toBe(200);

    // the model ceiling reached the wire — NOT the 8192 class cap
    expect(primaryMaxTokens).toBe(512);
    // truncation is deterministic: exactly ONE attempt, no wasted re-rolls
    expect(primaryHits).toBe(1);
    // ...and the chain advanced to a model that can hold the answer
    const body = (await res2.json()) as { model: string };
    expect(body.model).toBe('ollama/qwen3:14b');

    const clamped = audits.find((a) => a.event === 'max_tokens_clamped');
    expect(clamped?.detail).toMatchObject({ requested: 8192, served: 512 });
    const rejected = audits.find((a) => a.event === 'response_rejected');
    expect((rejected?.detail as { reason: string }).reason).toBe('json_truncated');

    await handle.db.update(models).set({ maxOutput: null }).where(eq(models.canonicalId, 'openai/gpt-4o-mini'));
    await new Promise((r) => setTimeout(r, 80));
  });

  it('a good primary is left alone — no retry, no fallback, no rejection audit', async () => {
    reset('json-ok');
    const res2 = await chat({ json: true });
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { model: string };
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(primaryHits).toBe(1);
    expect(secondaryHits).toBe(0);
    expect(audits.some((a) => a.event === 'response_rejected')).toBe(false);
  });
});

// ── chaos: primary that cannot be routed at all ──────────────────────────────

describe.skipIf(!url)('redundancy: primary cannot be routed → chain still runs', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let base: string;
  let upstream: Server;

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 5);
    const engine = new PolicyEngine(handle.db, 50);
    const firmId = (await handle.db.query.firms.findFirst())!.id;

    upstream = createServer((req, res2) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        if ((JSON.parse(body) as { stream?: boolean }).stream === true) {
          res2.writeHead(200, { 'content-type': 'text/event-stream' });
          res2.end(
            'data: {"choices":[{"delta":{"content":"served by fallback"},"finish_reason":null}]}\n\n' +
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          );
          return;
        }
        res2.writeHead(200, { 'content-type': 'application/json' });
        res2.end(
          JSON.stringify({
            choices: [{ message: { content: 'served by fallback' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 3 },
          }),
        );
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const a0 = upstream.address();
    const port = typeof a0 === 'object' && a0 ? a0.port : 0;

    await handle.db
      .update(providers)
      .set({ baseUrl: `http://127.0.0.1:${port}/v1` })
      .where(eq(providers.kind, 'local'));

    // seed configures ONLY a local provider: the anthropic model exists in the catalog with no
    // provider row behind it, so routing the PRIMARY throws provider_unavailable. The policy is
    // still savable — configTimeViolation checks sensitivity + capabilities, never provider
    // existence — which is exactly how a deleted provider or revoked credential presents.
    await savePolicy(handle.db, engine, {
      firmId,
      taskClassKey: 'tb_research_summary',
      defaultModelCanonicalId: 'anthropic/claude-sonnet-4-5',
      allowedModelCanonicalIds: ['anthropic/claude-sonnet-4-5'],
      fallbackChainCanonicalIds: ['ollama/qwen3:14b'],
    });

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
          resilience: {
            breaker: new CircuitBreaker({ minSamples: 50, openThreshold: 0.99, openDurationMs: 1000 }),
            shed: new LoadShedGuard(8, 8),
            totalTimeoutMs: 5_000,
            streamIdleTimeoutMs: 1_000,
          },
          rateLimits: { perToken: new RateLimiter(0), perUser: new RateLimiter(0) },
        },
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const a = app.server.address();
    if (a === null || typeof a === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${a.port}`;
  });

  afterAll(async () => {
    await app?.close();
    upstream?.close();
    await handle?.close();
  });

  const chat = (stream = false): Promise<Response> =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': 'tb_research_summary',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream }),
    });

  it('NON-STREAMING: the fallback hop serves instead of a 502', async () => {
    const res2 = await chat();
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { model: string };
    expect(body.model).toBe('ollama/qwen3:14b');
  });

  it('STREAMING: the fallback hop serves instead of a 502', async () => {
    const res2 = await chat(true);
    expect(res2.status).toBe(200);
    expect(await res2.text()).toContain('served by fallback');
  });

  it('the ledger still writes exactly one row, attributed to the serving model', async () => {
    const res2 = await chat();
    const row = await handle.db.query.usageLedger.findFirst({
      where: eq(usageLedger.requestId, res2.headers.get('x-request-id')!),
    });
    expect(row?.modelServed).toBe('ollama/qwen3:14b');
    expect(row?.status).toBe('ok');
  });
});

// ── unit: per-model output ceiling ───────────────────────────────────────────

describe('clampToModel (per-MODEL max_tokens)', () => {
  const model = (maxOutput: number | null): Parameters<typeof clampToModel>[1] =>
    ({ canonicalId: 'm', maxOutput }) as Parameters<typeof clampToModel>[1];

  it('clamps a request above the model ceiling', () => {
    const e = { ...env(), maxTokens: 32768 };
    expect(clampToModel(e, model(4096)).maxTokens).toBe(4096);
  });

  it('leaves a request at or below the ceiling untouched — same object, no allocation', () => {
    const e = { ...env(), maxTokens: 2048 };
    expect(clampToModel(e, model(4096))).toBe(e);
    const exact = { ...env(), maxTokens: 4096 };
    expect(clampToModel(exact, model(4096))).toBe(exact);
  });

  it('UNKNOWN max_output means do not clamp — never clamp to zero', () => {
    const e = { ...env(), maxTokens: 32768 };
    expect(clampToModel(e, model(null))).toBe(e);
    expect(clampToModel(e, model(0))).toBe(e);
  });

  it('never mutates the shared envelope — the next hop may have a HIGHER ceiling', () => {
    const shared = { ...env(), maxTokens: 32768 };
    const small = clampToModel(shared, model(4096));
    expect(small.maxTokens).toBe(4096);
    expect(shared.maxTokens).toBe(32768); // untouched
    expect(clampToModel(shared, model(32768)).maxTokens).toBe(32768);
  });
});
