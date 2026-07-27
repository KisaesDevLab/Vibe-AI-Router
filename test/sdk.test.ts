/**
 * SDK integration (12.1/12.2) + shadow harness (12.5) against a deterministic mock provider
 * through the REAL router pipeline and adapters.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { DbLedger } from '../src/ledger/writer.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { createLogger } from '../src/lib/logger.js';
import { providers, usageLedger } from '../db/schema.js';
import { resetDb } from './helpers.js';
import { DEMO } from '../db/seed.js';
import { VibeAiClient, VibeAiError } from '../packages/sdk/src/index.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];
const execFileAsync = promisify(execFile);

describe.skipIf(!url)('@kisaes/vibe-ai-client through the real router', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let mock: Server;
  let routerUrl: string;
  let client: VibeAiClient;

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 5);

    // deterministic mock model server (OpenAI dialect)
    mock = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        if (req.url?.includes('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'qwen3:14b' }] }));
          return;
        }
        const parsed = JSON.parse(body || '{}') as { stream?: boolean };
        const reply = '{"type":"asset","confidence":1}';
        if (parsed.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            `data: {"choices":[{"delta":{"content":${JSON.stringify(reply)}},"finish_reason":null}]}\n\n` +
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
              'data: {"choices":[],"usage":{"prompt_tokens":21,"completion_tokens":9}}\n\ndata: [DONE]\n\n',
          );
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: reply }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 21, completion_tokens: 9 },
            }),
          );
        }
      });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    const mockAddr = mock.address();
    const mockPort = typeof mockAddr === 'object' && mockAddr ? mockAddr.port : 0;
    await handle.db
      .update(providers)
      .set({ baseUrl: `http://127.0.0.1:${mockPort}/v1` })
      .where(eq(providers.kind, 'local'));

    app = buildApp({
      env: loadEnv({ DATABASE_URL: dbUrl, NODE_ENV: 'test' }),
      gateway: {
        deps: {
          db: handle.db,
          adapters: createAdapterRegistry(),
          ledger: new DbLedger(handle.db),
          log: createLogger('silent', false),
          engine: new PolicyEngine(handle.db, 50),
        },
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    routerUrl = `http://127.0.0.1:${addr.port}`;
    client = new VibeAiClient({ baseUrl: routerUrl, token: DEMO.appToken });
  });

  afterAll(async () => {
    await app?.close();
    mock?.close();
    await handle?.close();
  });

  it('complete(): content, usage, requestId, ledger attribution', async () => {
    const result = await client.complete(
      'tb_classification',
      [
        { role: 'system', content: 'classify' },
        { role: 'user', content: 'Cash - Operating' },
      ],
      { clientRef: 'SDKCLIENT', engagementRef: 'SDKENG', temperature: 0 },
    );
    expect(JSON.parse(result.content)).toEqual({ type: 'asset', confidence: 1 });
    expect(result.model).toBe('ollama/qwen3:14b');
    expect(result.usage.promptTokens).toBe(21);
    expect(result.requestId).toBeTruthy();

    const row = await handle.db.query.usageLedger.findFirst({
      where: eq(usageLedger.requestId, result.requestId),
    });
    expect(row?.clientRef).toBe('SDKCLIENT');
    expect(row?.engagementRef).toBe('SDKENG');
    expect(row?.app).toBe('vibe-tb');
  });

  it('stream(): deltas then finish then usage', async () => {
    let text = '';
    let finish = '';
    let usage;
    for await (const ev of client.stream('tb_classification', [{ role: 'user', content: 'x' }])) {
      if (ev.delta) text += ev.delta;
      if (ev.finishReason) finish = ev.finishReason;
      if (ev.usage) usage = ev.usage;
    }
    expect(JSON.parse(text)).toEqual({ type: 'asset', confidence: 1 });
    expect(finish).toBe('stop');
    expect(usage?.promptTokens).toBe(21);
  });

  it('registerTaskClasses(): new class lands local_only; idempotent (12.2)', async () => {
    const first = await client.registerTaskClasses({
      app: 'vibe-tb',
      version: '9.9.9',
      classes: [{ key: 'tb_sdk_new_class', requires: { json_schema: true } }],
    });
    expect(first.registered[0]).toMatchObject({ created: true, sensitivity: 'local_only' });
    const second = await client.registerTaskClasses({
      app: 'vibe-tb',
      version: '9.9.9',
      classes: [{ key: 'tb_sdk_new_class' }],
    });
    expect(second.registered[0]?.created).toBe(false);
  });

  it('errors surface as VibeAiError with taxonomy codes', async () => {
    try {
      await client.complete('no_such_class', [{ role: 'user', content: 'x' }]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(VibeAiError);
      expect((err as VibeAiError).code).toBe('policy_blocked');
      expect((err as VibeAiError).status).toBe(403);
      expect((err as VibeAiError).retryable).toBe(false);
    }
    const bad = new VibeAiClient({ baseUrl: routerUrl, token: 'wrong-token' });
    await expect(bad.complete('tb_classification', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'auth_error',
    });
  });

  it('billingUsage() returns line items for the period', async () => {
    const period = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
    const usage = await client.billingUsage(period, 'SDKCLIENT');
    expect(usage.period).toBe(period);
    expect(Array.isArray(usage.items)).toBe(true);
  });

  it('shadow harness (12.5): direct vs router on fixtures → 100% match, report written', async () => {
    const mockAddr = mock.address();
    const mockPort = typeof mockAddr === 'object' && mockAddr ? mockAddr.port : 0;
    await rm('SHADOW-DIFF-REPORT.md', { force: true });
    const { stdout } = await execFileAsync(
      'pnpm',
      ['exec', 'tsx', 'scripts/shadow-diff.ts'],
      {
        env: {
          ...process.env,
          SHADOW_DIRECT_URL: `http://127.0.0.1:${mockPort}/v1`,
          SHADOW_DIRECT_MODEL: 'qwen3:14b',
          SHADOW_ROUTER_URL: routerUrl,
          SHADOW_ROUTER_TOKEN: DEMO.appToken,
        },
        shell: process.platform === 'win32',
        timeout: 120_000,
      },
    );
    expect(stdout).toContain('match rate 100.0%');
    const report = await readFile('SHADOW-DIFF-REPORT.md', 'utf8');
    expect(report).toContain('Match rate: 20/20 (100.0%)');
    expect(report).not.toContain('asset'); // hashes only, no bodies
  }, 150_000);
});
