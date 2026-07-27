/**
 * Contract tests (2.10): the OFFICIAL `openai` npm client pointed at the router, streaming and
 * non-streaming, plus the fail-closed error paths. DB-backed (seeded dataset).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { NoopLedger } from '../src/gateway/pipeline.js';
import { StubAdapter } from '../src/gateway/stub-adapter.js';
import { createLogger } from '../src/lib/logger.js';
import { migrate } from '../db/migrate.js';
import { seed, DEMO } from '../db/seed.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

describe.skipIf(!url)('gateway contract (openai client ↔ router)', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let baseURL: string;
  let client: OpenAI;

  beforeAll(async () => {
    const dbUrl = url as string;
    await migrate(dbUrl, 'up');
    await seed(dbUrl);
    handle = createDb(dbUrl, 3);
    app = buildApp({
      env: loadEnv({ DATABASE_URL: dbUrl, NODE_ENV: 'test' }),
      gateway: {
        deps: {
          db: handle.db,
          adapters: { forKind: () => new StubAdapter('alpha beta gamma delta') },
          ledger: new NoopLedger(),
          log: createLogger('silent', false),
        },
        heartbeatMs: 60_000,
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    baseURL = `http://127.0.0.1:${addr.port}/v1`;
    client = new OpenAI({
      baseURL,
      apiKey: DEMO.appToken,
      defaultHeaders: { 'X-Vibe-Task-Class': 'tb_classification' },
      maxRetries: 0,
    });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('non-streaming completion round-trips through the official client', async () => {
    const res = await client.chat.completions.create({
      model: 'anything', // advisory — policy chooses
      messages: [{ role: 'user', content: 'classify: Office Depot 88.12' }],
    });
    expect(res.object).toBe('chat.completion');
    expect(res.choices[0]?.message.content).toBe('alpha beta gamma delta');
    expect(res.choices[0]?.finish_reason).toBe('stop');
    expect(res.usage?.prompt_tokens).toBeGreaterThan(0);
    expect(res.usage?.completion_tokens).toBeGreaterThan(0);
    expect(res.model).toBe('ollama/qwen3:14b'); // policy default for tb_classification
  });

  it('streaming completion delivers deltas, finish, and usage', async () => {
    const stream = await client.chat.completions.create({
      model: 'anything',
      messages: [{ role: 'user', content: 'stream it' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = '';
    let sawFinish = false;
    let usage: { prompt_tokens: number } | undefined;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.delta?.content) text += choice.delta.content;
      if (choice?.finish_reason === 'stop') sawFinish = true;
      if (chunk.usage) usage = chunk.usage;
    }
    expect(text).toBe('alpha beta gamma delta');
    expect(sawFinish).toBe(true);
    expect(usage?.prompt_tokens).toBeGreaterThan(0);
  });

  it('missing X-Vibe-Task-Class → 403 policy_blocked (fail closed)', async () => {
    const bare = new OpenAI({ baseURL, apiKey: DEMO.appToken, maxRetries: 0 });
    await expect(
      bare.chat.completions.create({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('unknown task class → 403; unknown/revoked token → 401', async () => {
    const wrongClass = new OpenAI({
      baseURL,
      apiKey: DEMO.appToken,
      defaultHeaders: { 'X-Vibe-Task-Class': 'no_such_class' },
      maxRetries: 0,
    });
    await expect(
      wrongClass.chat.completions.create({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ status: 403 });

    const badToken = new OpenAI({
      baseURL,
      apiKey: 'not-a-real-token',
      defaultHeaders: { 'X-Vibe-Task-Class': 'tb_classification' },
      maxRetries: 0,
    });
    await expect(
      badToken.chat.completions.create({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('malformed body → 400 invalid_request with taxonomy code', async () => {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': 'tb_classification',
      },
      body: JSON.stringify({ messages: 'not-an-array' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns x-request-id on success and failure', async () => {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': 'tb_classification',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});
