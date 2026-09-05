/**
 * DigitalOcean Gradient serverless inference as a provider kind (Q-060/Q-061).
 *
 * DO speaks the OpenAI wire protocol but is its OWN kind: routing picks the firm's provider
 * BY KIND, so `digitalocean` must route independently next to an OpenAI/Groq `openai_compat`
 * row. A mock HTTP server plays DO's API and captures what actually crosses the wire — the
 * assertions here are about the boundary: right URL, right auth header, prefix-stripped
 * model name, scrubbed content, correct ledger pricing, and the sensitivity tiers holding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { DbLedger } from '../src/ledger/writer.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { createLogger } from '../src/lib/logger.js';
import { savePolicy } from '../src/policy/save.js';
import { loadVendoredFeed, syncCatalog } from '../src/catalog/sync.js';
import { checkBaseUrl } from '../src/lib/ssrf.js';
import { modelPricing, models, policies, providers, taskClasses, usageLedger } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { resetDb } from './helpers.js';
import { DEMO } from '../db/seed.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

interface CapturedCall {
  path: string;
  authorization: string | undefined;
  body: { model?: string; messages?: { content?: string }[]; stream?: boolean };
}

describe.skipIf(!url)('DigitalOcean provider kind', () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let base: string;
  let doMock: Server;
  const captured: CapturedCall[] = [];
  const DO_KEY = 'do-test-model-access-key';

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 3);

    // the REAL production path: vendored feed (LiteLLM + curated DO file) → catalog
    const { feed, sha256 } = await loadVendoredFeed();
    await syncCatalog(handle.db, feed, { source: 'test-vendored', sourceSha256: sha256 });

    // mock playing inference.do-ai.run
    doMock = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as CapturedCall['body'];
        captured.push({ path: req.url ?? '', authorization: req.headers.authorization, body });
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunk = (delta: object): string =>
            `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta }] })}\n\n`;
          res.write(chunk({ role: 'assistant' }));
          res.write(chunk({ content: 'streamed from DO' }));
          res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-do-1',
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'reply from DO mock' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 200_000, completion_tokens: 100_000 },
          }),
        );
      });
    });
    await new Promise<void>((r) => doMock.listen(0, '127.0.0.1', r));
    const addr = doMock.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const firm = await handle.db.query.firms.findFirst();
    await handle.db.insert(providers).values({
      firmId: firm!.id,
      kind: 'digitalocean',
      label: 'DigitalOcean (mock)',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      authType: 'api_key',
    });

    const engine = new PolicyEngine(handle.db, 10);
    // NOTE deliberately not tb_doc_extract: it requires json_schema+vision, and the curated
    // DO capabilities are conservative (Q-062) — savePolicy refuses the combination at config
    // time, which gets its own assertion below.
    await savePolicy(handle.db, engine, {
      firmId: firm!.id,
      taskClassKey: 'tb_research_summary',
      defaultModelCanonicalId: 'digitalocean/llama3.3-70b-instruct',
      allowedModelCanonicalIds: ['digitalocean/llama3.3-70b-instruct'],
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
          ssrfDenyPrivateCloud: false, // the mock is loopback; SSRF gets its own direct tests below
          getApiKey: () => Promise.resolve(DO_KEY),
        },
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const appAddr = app.server.address();
    if (appAddr === null || typeof appAddr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${appAddr.port}`;
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((r) => doMock?.close(r));
    await handle?.close();
  });

  const chat = (taskClass: string, content: string, extra?: Record<string, unknown>): Promise<Response> =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': taskClass,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content }], ...extra }),
    });

  it('the vendored DO catalog syncs with kind digitalocean and real pricing', async () => {
    const rows = await handle.db.query.models.findMany({
      where: eq(models.providerKind, 'digitalocean'),
    });
    expect(rows.length).toBeGreaterThanOrEqual(14);
    const llama = rows.find((m) => m.canonicalId === 'digitalocean/llama3.3-70b-instruct');
    expect(llama).toBeDefined();
    expect(llama!.source).toBe('synced');
    expect(llama!.contextWindow).toBe(128_000);
    // conservative capabilities (Q-062): DO documents tool calling only for commercial models
    expect((llama!.capabilities as Record<string, boolean>)['tools']).toBeUndefined();
    const kimi = rows.find((m) => m.canonicalId === 'digitalocean/kimi-k2.5');
    expect((kimi!.capabilities as Record<string, boolean>)['vision']).toBe(true);
  });

  it('the 2026-09-03 additions are curated with DO specs and pricing (Vibe 1040 item E1)', async () => {
    const rows = await handle.db.query.models.findMany({ where: eq(models.providerKind, 'digitalocean') });
    const flash = rows.find((m) => m.canonicalId === 'digitalocean/glm-5.3-flash');
    expect(flash?.contextWindow).toBe(1_048_576);
    expect(flash?.capabilities).toMatchObject({ vision: true, json_schema: true, caching: true });
    const glm = rows.find((m) => m.canonicalId === 'digitalocean/glm-5.3');
    expect(glm?.contextWindow).toBe(1_048_576);
    expect((glm?.capabilities as Record<string, boolean>)['vision']).toBeUndefined(); // text only
    const qwenMax = rows.find((m) => m.canonicalId === 'digitalocean/qwen3.8-max');
    expect(qwenMax?.contextWindow).toBe(1_000_000);
    // vision set 2026-09-04: DO's serverless models page now documents "Text, images, and
    // video" input plus structured outputs for Qwen3.8-Max (it was one-page-only on 09-03)
    expect((qwenMax?.capabilities as Record<string, boolean>)['vision']).toBe(true);
    const price = await handle.db.query.modelPricing.findFirst({ where: eq(modelPricing.modelId, flash!.id) });
    expect(Number(price?.inputPerMtok)).toBe(0.15);
    expect(Number(price?.outputPerMtok)).toBe(0.5);
  });

  it('the 2026-09-04 refresh carries the GA DeepSeek variants and DO\'s current V4 pricing', async () => {
    const rows = await handle.db.query.models.findMany({ where: eq(models.providerKind, 'digitalocean') });
    const ga = rows.find((m) => m.canonicalId === 'digitalocean/deepseek-v4-pro-0813');
    expect(ga?.contextWindow).toBe(1_048_576);
    expect(ga?.capabilities).toMatchObject({ json_schema: true, caching: true });
    expect((ga?.capabilities as Record<string, boolean>)['vision']).toBeUndefined(); // text only
    const flashGa = rows.find((m) => m.canonicalId === 'digitalocean/deepseek-v4-flash-0731');
    expect(flashGa?.contextWindow).toBe(1_048_576);
    // the preview rows were repriced and widened to 1M on DO's pricing page (verified 1 Sep 2026)
    const pro = rows.find((m) => m.canonicalId === 'digitalocean/deepseek-v4-pro');
    expect(pro?.contextWindow).toBe(1_048_576);
    const proPrice = await handle.db.query.modelPricing.findFirst({ where: eq(modelPricing.modelId, pro!.id) });
    expect(Number(proPrice?.inputPerMtok)).toBe(0.87);
    expect(Number(proPrice?.outputPerMtok)).toBe(1.74);
  });

  it('a placeholder row discovered before curation is corrected in place by the nightly sync (Q-088 path)', async () => {
    // simulate: discovery inserted glm-5.3-flash with placeholder specs BEFORE the curated
    // entry shipped — delete the synced row and put the discovered-shaped one in its place
    const synced = await handle.db.query.models.findFirst({ where: eq(models.canonicalId, 'digitalocean/glm-5.3-flash') });
    await handle.db.delete(modelPricing).where(eq(modelPricing.modelId, synced!.id));
    await handle.db.delete(models).where(eq(models.id, synced!.id));
    const [placeholder] = await handle.db
      .insert(models)
      .values({
        canonicalId: 'digitalocean/glm-5.3-flash',
        providerKind: 'digitalocean',
        displayName: 'glm-5.3-flash',
        contextWindow: 8192, // DISCOVERED_CONTEXT_WINDOW
        capabilities: { json_schema: true },
        source: 'provider',
      })
      .returning();
    const { feed, sha256 } = await loadVendoredFeed();
    const report = await syncCatalog(handle.db, feed, { source: 'test-vendored', sourceSha256: sha256 });
    expect(report.updated).toContain('digitalocean/glm-5.3-flash');
    const after = await handle.db.query.models.findFirst({ where: eq(models.id, placeholder!.id) });
    // the curated context window replaces the 8192 placeholder — no operator hand-edit needed
    expect(after?.contextWindow).toBe(1_048_576);
    expect(after?.capabilities).toMatchObject({ vision: true, json_schema: true });
    expect(after?.source).toBe('provider'); // still operator-editable
    const pricing = await handle.db.query.modelPricing.findMany({ where: eq(modelPricing.modelId, placeholder!.id) });
    expect(pricing).toHaveLength(1);
  });

  it('routes to DO with the model access key and a prefix-stripped model name; ledger uses DO pricing', async () => {
    captured.length = 0;
    const res = await chat('tb_research_summary', 'summarize the ruling');
    expect(res.status).toBe(200);
    const requestId = res.headers.get('x-request-id') ?? '';
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]!.message.content).toBe('reply from DO mock');

    expect(captured).toHaveLength(1);
    expect(captured[0]!.path).toBe('/v1/chat/completions');
    expect(captured[0]!.authorization).toBe(`Bearer ${DO_KEY}`);
    // canonical id digitalocean/llama3.3-70b-instruct → DO's native id on the wire
    expect(captured[0]!.body.model).toBe('llama3.3-70b-instruct');

    // 200k in + 100k out at $0.65/$0.65 per MTok = $0.195 = 19.5 cents, measured not estimated
    const row = await handle.db.query.usageLedger.findFirst({
      where: eq(usageLedger.requestId, requestId),
    });
    expect(row).toBeDefined();
    expect(Number(row!.costCents)).toBeCloseTo(19.5, 6);
    expect(row!.costUnknown).toBe(false);
  });

  it('streams through the DO provider (SSE end to end)', async () => {
    const res = await chat('tb_research_summary', 'stream it', { stream: true });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('streamed from DO');
    expect(text).toContain('data: [DONE]');
  });

  it('scrubber redacts protected numbers before they reach DO (cloud-bound tier)', async () => {
    captured.length = 0;
    const res = await chat('tb_research_summary', 'client SSN is 123-45-6789, summarize the rest');
    expect(res.status).toBe(200);
    const sent = JSON.stringify(captured[0]!.body);
    expect(sent).not.toContain('123-45-6789');
    expect(sent).toContain('[SSN]');
  });

  it('capability gating refuses DO models for classes requiring undeclared capabilities (config time)', async () => {
    // tb_doc_extract requires json_schema+vision; the curated DO entries deliberately do not
    // claim them (DO documents tool calling only for its commercial models). Reject at save,
    // never degrade silently (invariant #7). Operators unlock per model via capabilityOverrides.
    const firm = await handle.db.query.firms.findFirst();
    await expect(
      savePolicy(handle.db, new PolicyEngine(handle.db, 10), {
        firmId: firm!.id,
        taskClassKey: 'tb_doc_extract',
        defaultModelCanonicalId: 'digitalocean/llama3.3-70b-instruct',
      }),
    ).rejects.toThrow(/missing capability/);
  });

  it('local_only can NEVER reach DO — even via a policy row written around the admin API', async () => {
    // config-time gate: savePolicy refuses the combination outright
    const firm = await handle.db.query.firms.findFirst();
    const engine = new PolicyEngine(handle.db, 10);
    await expect(
      savePolicy(handle.db, engine, {
        firmId: firm!.id,
        taskClassKey: 'tb_classification', // local_only
        defaultModelCanonicalId: 'digitalocean/llama3.3-70b-instruct',
      }),
    ).rejects.toThrow(/local_only/);

    // request-time gate (defense in depth): plant the row directly and the pipeline still blocks
    const tc = await handle.db.query.taskClasses.findFirst({
      where: eq(taskClasses.key, 'tb_classification'),
    });
    const doModel = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'digitalocean/llama3.3-70b-instruct'),
    });
    await handle.db.delete(policies).where(eq(policies.taskClassId, tc!.id));
    await handle.db.insert(policies).values({
      firmId: firm!.id,
      taskClassId: tc!.id,
      defaultModelId: doModel!.id,
    });
    captured.length = 0;
    const res = await chat('tb_classification', 'classify: office supplies 88.12');
    expect(res.status).toBeGreaterThanOrEqual(400);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(/local_only/);
    expect(captured).toHaveLength(0); // nothing crossed the wire
  });

  it('SSRF gates treat digitalocean as a cloud kind', () => {
    expect(checkBaseUrl('digitalocean', 'https://inference.do-ai.run/v1').ok).toBe(true);
    expect(checkBaseUrl('digitalocean', 'http://inference.do-ai.run/v1').ok).toBe(false); // https only
    expect(checkBaseUrl('digitalocean', 'https://192.168.1.50/v1').ok).toBe(false); // no private hosts
    expect(checkBaseUrl('digitalocean', 'https://169.254.169.254/v1').ok).toBe(false); // no metadata
  });
});
