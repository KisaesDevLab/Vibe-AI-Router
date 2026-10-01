/**
 * Provider catalog refresh (Q-101): Anthropic live model discovery, the live pricing feed, and
 * the orchestrated pass across linked DigitalOcean + Anthropic providers. Asserts the ownership
 * rules that keep it safe to run unattended: discovered rows only, never an id the vendored
 * feed carries, never a half-published price, and NO pricing churn when the vendored sync runs
 * after it night after night.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createDb, type DbHandle } from '../src/db/client.js';
import { resetDb } from './helpers.js';
import { modelPricing, models, providers } from '../db/schema.js';
import {
  anthropicCapabilities,
  discoverAnthropicModels,
  DISCOVERED_CONTEXT_WINDOW,
  listAnthropicModels,
} from '../src/catalog/discovery.js';
import { applyLivePricing } from '../src/catalog/live-pricing.js';
import { refreshProviderCatalog } from '../src/catalog/refresh.js';
import { loadCuratedIds, loadVendoredFeed, syncCatalog } from '../src/catalog/sync.js';
import type { FetchPage } from '../src/catalog/do-docs.js';
import { createLogger } from '../src/lib/logger.js';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/server/app.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { NoopLedger } from '../src/gateway/pipeline.js';
import { StubAdapter } from '../src/gateway/stub-adapter.js';
import { SessionStore } from '../src/admin-api/session.js';
import { CredentialVault } from '../src/vault/service.js';
import { keyringFromEnv } from '../src/vault/crypto.js';
import { DEMO } from '../db/seed.js';

const log = createLogger('silent', false);

const OPUS_55 = {
  type: 'model',
  id: 'claude-opus-5-5',
  display_name: 'Claude Opus 5.5',
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  capabilities: {
    image_input: { supported: true },
    structured_outputs: { supported: true },
    thinking: { supported: true, types: { adaptive: { supported: true } } },
  },
};
/** vendored feed already carries this id — discovery must leave it to the sync */
const OPUS_48 = {
  type: 'model',
  id: 'claude-opus-4-8',
  display_name: 'Claude Opus 4.8',
  max_input_tokens: 1_000_000,
};
/** a proxy that reports ids only */
const BARE = { id: 'claude-bare-x' };

/** LiteLLM-shaped live feed: per-TOKEN costs */
const LIVE_FEED = JSON.stringify({
  'claude-opus-5-5': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    max_input_tokens: 1_000_000,
    max_output_tokens: 128_000,
    input_cost_per_token: 0.000004,
    output_cost_per_token: 0.00002,
    cache_read_input_token_cost: 2e-7,
  },
  // differs from the vendored price on purpose — must never be applied (vendored owns the id)
  'claude-opus-4-8': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    max_input_tokens: 1_000_000,
    input_cost_per_token: 0.000099,
    output_cost_per_token: 0.000099,
  },
  'claude-bare-x': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    max_input_tokens: 200_000,
    max_output_tokens: 64_000,
    input_cost_per_token: 0.000001, // output price missing → specs fill, price refused
  },
});

describe('anthropicCapabilities (pure)', () => {
  it('maps the capability tree; asserts tools + caching for the kind; leaves absent leaves unset', () => {
    expect(anthropicCapabilities(OPUS_55.capabilities)).toEqual({
      tools: true,
      caching: true,
      vision: true,
      json_schema: true,
      reasoning: true,
    });
    expect(anthropicCapabilities({ image_input: { supported: false }, thinking: 'yes' })).toEqual({
      tools: true,
      caching: true,
      vision: false,
    });
    expect(anthropicCapabilities(undefined)).toEqual({ tools: true, caching: true });
  });
});

describe('listAnthropicModels (pagination)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('follows has_more / last_id and sends the key as x-api-key, never as a bearer token', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      const first = !url.includes('after_id=');
      return Promise.resolve(
        new Response(
          JSON.stringify(
            first
              ? { data: [{ id: 'a' }], has_more: true, last_id: 'a' }
              : { data: [{ id: 'b' }], has_more: false, last_id: 'b' },
          ),
          { status: 200 },
        ),
      );
    });
    const out = await listAnthropicModels(
      'https://api.anthropic.com/',
      'sk-ant-test',
      AbortSignal.timeout(5000),
    );
    expect(out).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.anthropic.com/v1/models?limit=1000',
      'https://api.anthropic.com/v1/models?limit=1000&after_id=a',
    ]);
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-test');
    expect(calls[0]!.headers['anthropic-version']).toBeDefined();
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });
});

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

describe.skipIf(!url)('provider catalog refresh (DB)', () => {
  let handle: DbHandle;
  let firmId: string;
  let anthropicProvider: typeof providers.$inferSelect;
  let curatedIds: Set<string>;

  const row = (canonicalId: string): Promise<typeof models.$inferSelect | undefined> =>
    handle.db.query.models.findFirst({ where: eq(models.canonicalId, canonicalId) });
  const pricingOf = async (canonicalId: string): Promise<(typeof modelPricing.$inferSelect)[]> => {
    const m = await row(canonicalId);
    return m ? handle.db.query.modelPricing.findMany({ where: eq(modelPricing.modelId, m.id) }) : [];
  };
  const runVendoredSync = async (): Promise<Awaited<ReturnType<typeof syncCatalog>>> => {
    const { feed, sha256 } = await loadVendoredFeed();
    return syncCatalog(handle.db, feed, { source: 'vendored:litellm', sourceSha256: sha256 });
  };

  beforeAll(async () => {
    await resetDb(url!);
    handle = createDb(url!, 2);
    firmId = (await handle.db.query.firms.findFirst())!.id;
    const [p] = await handle.db
      .insert(providers)
      .values({
        firmId,
        kind: 'anthropic',
        label: 'Anthropic test',
        baseUrl: 'https://api.anthropic.com',
        authType: 'api_key',
      })
      .returning();
    anthropicProvider = p!;
    curatedIds = await loadCuratedIds();
    return async () => handle.close();
  });

  it('the vendored feed carries opus-4-8 but not opus-5-5 (fixture premise)', () => {
    expect(curatedIds.has('anthropic/claude-opus-4-8')).toBe(true);
    expect(curatedIds.has('anthropic/claude-opus-5-5')).toBe(false);
  });

  it('discovers unknown Claude models with the API specs; leaves vendored ids to the sync; idempotent', async () => {
    const listModels = (): Promise<unknown[]> =>
      Promise.resolve([OPUS_55, OPUS_48, BARE, { id: 'bad id\nwith control' }, 42, OPUS_55]);
    const res = await discoverAnthropicModels(handle.db, anthropicProvider, 'key', {
      listModels,
      curatedIds,
    });
    expect(res.discovered.sort()).toEqual(['anthropic/claude-bare-x', 'anthropic/claude-opus-5-5']);
    expect(res.skipped).toHaveLength(2);
    // a hostile id is counted, never inserted and never echoed back
    expect(res.skipped).toEqual(['malformed entry', 'malformed entry']);

    const opus = await row('anthropic/claude-opus-5-5');
    expect(opus?.source).toBe('provider');
    expect(opus?.providerKind).toBe('anthropic');
    expect(opus?.displayName).toBe('Claude Opus 5.5');
    expect(opus?.contextWindow).toBe(1_000_000);
    expect(opus?.maxOutput).toBe(128_000);
    expect(opus?.capabilities).toEqual({
      tools: true,
      caching: true,
      vision: true,
      json_schema: true,
      reasoning: true,
    });
    expect(await pricingOf('anthropic/claude-opus-5-5')).toHaveLength(0); // the API publishes no price

    // ids-only entry falls back to the conservative placeholder
    const bare = await row('anthropic/claude-bare-x');
    expect(bare?.contextWindow).toBe(DISCOVERED_CONTEXT_WINDOW);
    expect(bare?.maxOutput).toBeNull();

    // vendored-owned id is NOT inserted as a 'provider' row
    expect((await row('anthropic/claude-opus-4-8'))?.source ?? 'synced').toBe('synced');

    const res2 = await discoverAnthropicModels(handle.db, anthropicProvider, 'key', {
      listModels,
      curatedIds,
    });
    expect(res2.discovered).toEqual([]);
  });

  it('an operator-corrected spec on a discovered row survives a re-pull', async () => {
    const opus = await row('anthropic/claude-opus-5-5');
    await handle.db.update(models).set({ contextWindow: 500_000 }).where(eq(models.id, opus!.id));
    await discoverAnthropicModels(handle.db, anthropicProvider, 'key', {
      listModels: () => Promise.resolve([OPUS_55]),
      curatedIds,
    });
    expect((await row('anthropic/claude-opus-5-5'))?.contextWindow).toBe(500_000);
    await handle.db.update(models).set({ contextWindow: 1_000_000 }).where(eq(models.id, opus!.id));
  });

  it('live pricing: prices discovered rows, refuses half prices, never touches vendored ids; idempotent', async () => {
    await runVendoredSync(); // creates anthropic/claude-opus-4-8 as a synced row with vendored pricing
    const vendoredBefore = await pricingOf('anthropic/claude-opus-4-8');
    expect(vendoredBefore.length).toBeGreaterThan(0);

    const report = await applyLivePricing(handle.db, LIVE_FEED, { curatedIds });
    expect(report.pricingChanged).toEqual(['anthropic/claude-opus-5-5']);
    expect(report.sourceSha256).toMatch(/^[0-9a-f]{64}$/);

    const priced = await pricingOf('anthropic/claude-opus-5-5');
    expect(priced).toHaveLength(1);
    expect(Number(priced[0]!.inputPerMtok)).toBe(4);
    expect(Number(priced[0]!.outputPerMtok)).toBe(20);
    expect(Number(priced[0]!.cacheReadPerMtok)).toBe(0.2);

    // output price unpublished → no pricing row (stays cost_unknown), but placeholder specs fill
    expect(await pricingOf('anthropic/claude-bare-x')).toHaveLength(0);
    expect(report.specsUpdated).toEqual(['anthropic/claude-bare-x']);
    const bare = await row('anthropic/claude-bare-x');
    expect(bare?.contextWindow).toBe(200_000);
    expect(bare?.maxOutput).toBe(64_000);

    // the vendored-owned row kept its pinned price despite a different live one
    expect(await pricingOf('anthropic/claude-opus-4-8')).toHaveLength(vendoredBefore.length);

    const again = await applyLivePricing(handle.db, LIVE_FEED, { curatedIds });
    expect(again.pricingChanged).toEqual([]);
    expect(again.specsUpdated).toEqual([]);
    expect(await pricingOf('anthropic/claude-opus-5-5')).toHaveLength(1);
  });

  it('live pricing rejects a payload that is not a JSON object', async () => {
    await expect(applyLivePricing(handle.db, '[1,2]', { curatedIds })).rejects.toThrow(/not a JSON object/);
    await expect(applyLivePricing(handle.db, '<html>', { curatedIds })).rejects.toThrow();
  });

  it('a price change upstream appends history; the vendored sync after it causes no churn', async () => {
    const repriced = JSON.stringify({
      'claude-opus-5-5': {
        litellm_provider: 'anthropic',
        mode: 'chat',
        max_input_tokens: 1_000_000,
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
      },
    });
    const report = await applyLivePricing(handle.db, repriced, { curatedIds });
    expect(report.pricingChanged).toEqual(['anthropic/claude-opus-5-5']);
    expect(await pricingOf('anthropic/claude-opus-5-5')).toHaveLength(2); // append-only

    // night after night: sync → live → sync must not write another pricing row anywhere
    const count = async (): Promise<number> => (await handle.db.query.modelPricing.findMany()).length;
    const before = await count();
    const sync1 = await runVendoredSync();
    await applyLivePricing(handle.db, repriced, { curatedIds });
    const sync2 = await runVendoredSync();
    expect(sync1.pricingChanged).toEqual([]);
    expect(sync2.pricingChanged).toEqual([]);
    expect(sync2.updated).toEqual([]);
    expect(await count()).toBe(before);
    // and the vendored sync never deprecates a discovered row it does not carry
    expect((await row('anthropic/claude-opus-5-5'))?.status).toBe('active');
  });

  describe('refreshProviderCatalog (orchestrated)', () => {
    const fixture = (name: string): Promise<string> =>
      readFile(join(import.meta.dirname, 'fixtures', 'do-docs', name), 'utf8');
    const fetchDocsPage: FetchPage = (u) => fixture(u.includes('pricing') ? 'pricing.html' : 'models.html');

    it('pulls models and pricing for every linked DO + Anthropic provider; reports a failing one', async () => {
      await handle.db.insert(providers).values([
        {
          firmId,
          kind: 'digitalocean',
          label: 'DO test',
          baseUrl: 'https://inference.do-ai.run/v1',
          authType: 'api_key',
        },
        {
          firmId,
          kind: 'anthropic',
          label: 'Anthropic down',
          baseUrl: 'https://down.invalid',
          authType: 'api_key',
        },
        // not a discoverable kind — must be ignored entirely
        {
          firmId,
          kind: 'openai_compat',
          label: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          authType: 'api_key',
        },
      ]);
      const feedFetches: string[] = [];
      const report = await refreshProviderCatalog(handle.db, log, () => Promise.resolve('key'), {
        firmId,
        pricingFeedUrl: 'https://feed.test/prices.json',
        fetchDocsPage,
        fetchPricingFeed: (u) => {
          feedFetches.push(u);
          return Promise.resolve(LIVE_FEED);
        },
        discover: {
          // kimi-k3 is vendored (enrich-only); kimi-k2.6 arrives via the sync; the third is new
          listIds: () => Promise.resolve(['kimi-k3', 'anthropic-claude-opus-4.7']),
          listAnthropicModels: (baseUrl) =>
            baseUrl.includes('down.invalid')
              ? Promise.reject(new Error('provider HTTP 401'))
              : Promise.resolve([
                  OPUS_55,
                  { ...OPUS_55, id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
                ]),
        },
      });

      expect(report.providers.map((p) => p.providerLabel).sort()).toEqual(['Anthropic test', 'DO test']);
      expect(report.failed).toEqual([{ providerLabel: 'Anthropic down', reason: 'provider HTTP 401' }]);
      expect(report.providers.flatMap((p) => p.discovered).sort()).toEqual([
        'anthropic/claude-sonnet-5-5',
        'digitalocean/anthropic-claude-opus-4.7',
        'digitalocean/kimi-k3',
      ]);
      expect(feedFetches).toEqual(['https://feed.test/prices.json']);
      expect(report.pricingErrors).toEqual([]);

      // DO docs ran; the vendored-owned id was left to the vendored sync
      expect(report.doDocs).not.toBeNull();
      expect(report.doDocs!.skippedCurated).toContain('digitalocean/kimi-k3');
      expect(await pricingOf('digitalocean/kimi-k3')).toHaveLength(0);

      // audit trail: discovery per provider with additions
      const audits = await handle.db.query.auditLog.findMany();
      expect(audits.filter((a) => a.event === 'provider_models_discovered')).toHaveLength(2);
    });

    it('fetches no price feed when it is disabled, and none when no Anthropic provider answered', async () => {
      let fetched = 0;
      const fetchPricingFeed = (): Promise<string> => {
        fetched++;
        return Promise.resolve(LIVE_FEED);
      };
      // disabled (no URL)
      await refreshProviderCatalog(handle.db, log, () => Promise.resolve('key'), {
        fetchDocsPage,
        fetchPricingFeed,
        discover: { listIds: () => Promise.resolve([]), listAnthropicModels: () => Promise.resolve([]) },
      });
      // enabled, but every Anthropic provider is unreachable
      const report = await refreshProviderCatalog(handle.db, log, () => Promise.resolve('key'), {
        pricingFeedUrl: 'https://feed.test/prices.json',
        fetchDocsPage,
        fetchPricingFeed,
        discover: {
          listIds: () => Promise.resolve([]),
          listAnthropicModels: () => Promise.reject(new Error('provider HTTP 503')),
        },
      });
      expect(fetched).toBe(0);
      expect(report.livePricing).toBeNull();
      expect(report.failed).toHaveLength(2);
    });

    it('a failing price feed or docs page is reported, never thrown', async () => {
      const report = await refreshProviderCatalog(handle.db, log, () => Promise.resolve('key'), {
        pricingFeedUrl: 'https://feed.test/prices.json',
        fetchDocsPage: () => Promise.reject(new Error('DO docs fetch failed: HTTP 500')),
        fetchPricingFeed: () => Promise.reject(new Error('pricing feed fetch failed: HTTP 404')),
        discover: {
          listIds: () => Promise.resolve([]),
          listAnthropicModels: (baseUrl) =>
            baseUrl.includes('down.invalid') ? Promise.reject(new Error('x')) : Promise.resolve([]),
        },
      });
      expect(report.pricingErrors).toEqual([
        'DigitalOcean docs: DO docs fetch failed: HTTP 500',
        'pricing feed: pricing feed fetch failed: HTTP 404',
      ]);
    });
  });
});

describe.skipIf(!url)('POST /admin-api/catalog/refresh', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let base: string;
  let cookie: string;

  beforeAll(async () => {
    await resetDb(url!);
    handle = createDb(url!, 2);
    const keyring = keyringFromEnv({
      MASTER_KEY: randomBytes(32).toString('base64'),
      MASTER_KEY_VERSION: 1,
    })!;
    app = buildApp({
      env: loadEnv({ DATABASE_URL: url!, NODE_ENV: 'test' }),
      gateway: {
        deps: {
          db: handle.db,
          adapters: { forKind: () => new StubAdapter() },
          ledger: new NoopLedger(),
          log,
          engine: new PolicyEngine(handle.db),
        },
      },
      adminApi: {
        sessions: new SessionStore('catalog-refresh-secret'),
        secureCookies: false,
        vault: new CredentialVault(handle.db, keyring, log, 24),
        adapterFor: () => undefined,
        refreshCatalog: () => {},
        pricingFeedUrl: 'https://feed.test/prices.json',
        fetchPricingFeed: () => Promise.resolve(LIVE_FEED),
        fetchDocsPage: () => Promise.reject(new Error('unused')),
        discoverSeams: { listAnthropicModels: () => Promise.resolve([OPUS_55]) },
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
    const login = await fetch(`${base}/admin-api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vibe-admin': '1' },
      body: JSON.stringify({ email: DEMO.adminEmail, password: DEMO.adminPassword }),
    });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('requires an admin session', async () => {
    const res = await fetch(`${base}/admin-api/catalog/refresh`, {
      method: 'POST',
      headers: { 'x-vibe-admin': '1' },
    });
    expect(res.status).toBe(401);
  });

  it('discovers, prices and syncs in one call — and the response carries no credential', async () => {
    const firm = await handle.db.query.firms.findFirst();
    const [p] = await handle.db
      .insert(providers)
      .values({
        firmId: firm!.id,
        kind: 'anthropic',
        label: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        authType: 'api_key',
      })
      .returning();
    const secret = 'sk-ant-refresh-endpoint-secret-0001';
    const cred = await fetch(`${base}/admin-api/providers/${p!.id}/credentials`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-vibe-admin': '1' },
      body: JSON.stringify({ apiKey: secret }),
    });
    expect(cred.status).toBe(201);

    const res = await fetch(`${base}/admin-api/catalog/refresh`, {
      method: 'POST',
      headers: { cookie, 'x-vibe-admin': '1' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(secret);
    const body = JSON.parse(text) as {
      providers: { discovered: string[] }[];
      livePricing: { pricingChanged: string[] } | null;
      vendoredSync: { added: number } | null;
    };
    expect(body.providers[0]!.discovered).toEqual(['anthropic/claude-opus-5-5']);
    expect(body.livePricing?.pricingChanged).toEqual(['anthropic/claude-opus-5-5']);
    expect(body.vendoredSync).not.toBeNull();

    const models_ = (await (
      await fetch(`${base}/admin-api/models?search=claude-opus-5-5`, { headers: { cookie } })
    ).json()) as { canonicalId: string; pricing: { inputPerMtok: string } | null }[];
    expect(Number(models_[0]!.pricing?.inputPerMtok)).toBe(4);
  });
});
