/**
 * Catalog & pricing sync (5.9): idempotency, override survival, diff accuracy, deprecation
 * flagging, pricing append-only history, custom model validation.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type DbHandle } from '../src/db/client.js';
import { resetDb } from './helpers.js';
import { modelPricing, models } from '../db/schema.js';
import { parseFeed, syncCatalog } from '../src/catalog/sync.js';
import {
  createCustomModel,
  effectiveCapabilities,
  findRetiredModelReferences,
  pricingAt,
  setCapabilityOverrides,
  updateModel,
} from '../src/catalog/service.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

const FEED_V1: Record<string, unknown> = {
  'gpt-test-1': {
    max_input_tokens: 100000,
    max_output_tokens: 8000,
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    litellm_provider: 'openai',
    mode: 'chat',
    supports_function_calling: true,
    supports_response_schema: true,
    supports_vision: false,
  },
  'claude-test-1': {
    max_input_tokens: 200000,
    max_output_tokens: 64000,
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 0.00000375,
    litellm_provider: 'anthropic',
    mode: 'chat',
    supports_function_calling: true,
    supports_prompt_caching: true,
  },
  'ollama/test-local': {
    max_tokens: 32768,
    litellm_provider: 'ollama',
    mode: 'chat',
    supports_function_calling: true,
  },
  'text-embedding-x': { max_input_tokens: 8191, litellm_provider: 'openai', mode: 'embedding' },
  'no-context-model': { litellm_provider: 'openai', mode: 'chat' },
};

describe('parseFeed (pure)', () => {
  it('maps providers to kinds, prefixes canonical ids, converts pricing to $/MTok', () => {
    const { entries, skipped } = parseFeed(FEED_V1);
    const byId = new Map(entries.map((e) => [e.canonicalId, e]));
    expect(byId.get('openai/gpt-test-1')?.providerKind).toBe('openai_compat');
    expect(byId.get('anthropic/claude-test-1')?.providerKind).toBe('anthropic');
    expect(byId.get('ollama/test-local')?.providerKind).toBe('local');
    expect(byId.get('openai/gpt-test-1')?.pricing.inputPerMtok).toBe('2.5');
    expect(byId.get('anthropic/claude-test-1')?.pricing.cacheReadPerMtok).toBe('0.3');
    expect(byId.get('anthropic/claude-test-1')?.capabilities).toEqual({ tools: true, caching: true });
    // embedding mode + missing context are skipped, with names reported
    expect(skipped).toContain('text-embedding-x');
    expect(skipped).toContain('no-context-model');
  });

  it('parses the real vendored feed without errors', async () => {
    const { loadVendoredFeed } = await import('../src/catalog/sync.js');
    const { feed } = await loadVendoredFeed();
    const { entries } = parseFeed(feed);
    expect(entries.length).toBeGreaterThan(100);
    // spot-check a few staples exist with sane pricing
    const claude = entries.find((e) => e.canonicalId.startsWith('anthropic/claude'));
    expect(claude).toBeDefined();
    expect(Number(claude?.pricing.inputPerMtok)).toBeGreaterThan(0);
  });
});

describe('effectiveCapabilities — per-kind ceiling (Q-097, pure)', () => {
  type ModelRow = typeof models.$inferSelect;
  const row = (over: Partial<ModelRow>): ModelRow =>
    ({
      id: 'm',
      canonicalId: 'glm/GLM-OCR',
      providerKind: 'local_ocr',
      displayName: 'GLM-OCR',
      contextWindow: 8192,
      maxOutput: null,
      capabilities: {},
      capabilityOverrides: {},
      status: 'active',
      deprecationDate: null,
      source: 'custom',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    }) as ModelRow;

  it('local_ocr: json_schema/tools are false even when the row advertises them; vision passes through', () => {
    const caps = effectiveCapabilities(row({ capabilities: { vision: true, json_schema: true, tools: true } }));
    expect(caps).toMatchObject({ vision: true, json_schema: false, tools: false });
  });

  it('local_ocr: an explicit override re-enables json_schema (operator verified grammar support)', () => {
    const caps = effectiveCapabilities(
      row({ capabilities: { vision: true, json_schema: true }, capabilityOverrides: { json_schema: true } }),
    );
    expect(caps).toMatchObject({ vision: true, json_schema: true, tools: false });
  });

  it('other kinds are unaffected: base values pass through and overrides still win', () => {
    const caps = effectiveCapabilities(
      row({ providerKind: 'local', canonicalId: 'ollama/x', capabilities: { json_schema: true, tools: true } }),
    );
    expect(caps).toMatchObject({ json_schema: true, tools: true, vision: false });
    const overridden = effectiveCapabilities(
      row({ providerKind: 'digitalocean', capabilities: { json_schema: true }, capabilityOverrides: { json_schema: false } }),
    );
    expect(overridden.json_schema).toBe(false);
  });
});

describe.skipIf(!url)('syncCatalog (DB)', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl); // exact-diff assertions need a clean slate
    handle = createDb(dbUrl, 2);
    return async () => handle.close();
  });

  it('the REAL vendored feed syncs completely and idempotently (duplicate-key regression)', async () => {
    // The hand-made FEED_V1 below has no duplicate canonical ids; the real feed does (the
    // same model appears under a bare key AND a namespaced one). A plain insert died on the
    // unique constraint mid-run, so the nightly sync silently applied only the models before
    // the first collision. This test drives the actual shipped file through the DB path.
    const { loadVendoredFeed } = await import('../src/catalog/sync.js');
    const { feed } = await loadVendoredFeed();
    const { entries } = parseFeed(feed);

    await syncCatalog(handle.db, feed, { source: 'vendored', sourceSha256: 'v1' });
    const afterFirst = await handle.db.query.models.findMany();
    // completeness: EVERY parsed model with published specs reached the DB (the bug applied
    // only the models preceding the first duplicate, leaving the rest silently unsynced).
    // Enrich-only entries (contextWindow null, Q-088) never insert by design.
    const present = new Set(afterFirst.map((m) => m.canonicalId));
    const missing = entries
      .filter((e) => e.contextWindow !== null)
      .map((e) => e.canonicalId)
      .filter((id) => !present.has(id));
    expect(missing, `feed models never synced: ${missing.slice(0, 5).join(', ')}`).toEqual([]);

    const second = await syncCatalog(handle.db, feed, { source: 'vendored', sourceSha256: 'v1' });
    expect(second.added).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.pricingChanged).toEqual([]);
    expect((await handle.db.query.models.findMany()).length).toBe(afterFirst.length);

    // and every canonical id is unique after parsing (the dedupe contract)
    const ids = entries.map((e) => e.canonicalId);
    expect(new Set(ids).size).toBe(ids.length);

    // clean slate for the hand-made-feed tests that follow
    await resetDb(url as string);
  });

  it('first sync adds; second identical sync is a no-op (idempotency)', async () => {
    const r1 = await syncCatalog(handle.db, FEED_V1, { source: 't', sourceSha256: 'a' });
    expect(r1.added.sort()).toEqual(['anthropic/claude-test-1', 'ollama/test-local', 'openai/gpt-test-1']);
    expect(r1.pricingChanged.length).toBe(2); // local model has no pricing in feed

    const r2 = await syncCatalog(handle.db, FEED_V1, { source: 't', sourceSha256: 'a' });
    expect(r2.added).toEqual([]);
    expect(r2.updated).toEqual([]);
    expect(r2.pricingChanged).toEqual([]);
    expect(r2.deprecated).toEqual([]);
  });

  it('pricing change appends a history row; old row preserved (5.4)', async () => {
    const feedV2 = structuredClone(FEED_V1) as Record<string, Record<string, unknown>>;
    feedV2['gpt-test-1']!['input_cost_per_token'] = 0.000005; // price hike
    const r = await syncCatalog(handle.db, feedV2, { source: 't', sourceSha256: 'b' });
    expect(r.pricingChanged).toEqual(['openai/gpt-test-1']);

    const model = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'openai/gpt-test-1'),
    });
    const history = await handle.db.query.modelPricing.findMany({
      where: eq(modelPricing.modelId, model!.id),
      orderBy: modelPricing.effectiveFrom,
    });
    expect(history.length).toBe(2);
    expect(Number(history[0]!.inputPerMtok)).toBe(2.5);
    expect(Number(history[1]!.inputPerMtok)).toBe(5);

    // pricingAt honors effective_from ordering
    const latest = await pricingAt(handle.db, model!.id, new Date());
    expect(Number(latest!.inputPerMtok)).toBe(5);
  });

  it('capability overrides survive re-sync and win over synced values (5.5)', async () => {
    const model = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'openai/gpt-test-1'),
    });
    await setCapabilityOverrides(handle.db, model!.id, { vision: true });
    await syncCatalog(handle.db, FEED_V1, { source: 't', sourceSha256: 'c' });
    const after = await handle.db.query.models.findFirst({ where: eq(models.id, model!.id) });
    expect((after!.capabilityOverrides as Record<string, boolean>)['vision']).toBe(true);
    expect(effectiveCapabilities(after!)).toMatchObject({ vision: true, tools: true });
  });

  it('vanished models flagged deprecated, never deleted; reappearing models reactivate (5.3)', async () => {
    const feedWithout = structuredClone(FEED_V1) as Record<string, unknown>;
    delete feedWithout['gpt-test-1'];
    const r = await syncCatalog(handle.db, feedWithout, { source: 't', sourceSha256: 'd' });
    expect(r.deprecated).toContain('openai/gpt-test-1');
    const gone = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'openai/gpt-test-1'),
    });
    expect(gone?.status).toBe('deprecated');

    const r2 = await syncCatalog(handle.db, FEED_V1, { source: 't', sourceSha256: 'e' });
    expect(r2.updated).toContain('openai/gpt-test-1');
    const back = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'openai/gpt-test-1'),
    });
    expect(back?.status).toBe('active');
  });

  it('custom (seed) models are never touched by sync', async () => {
    const custom = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'ollama/qwen3:14b'),
    });
    expect(custom?.source).toBe('custom');
    expect(custom?.status).toBe('active'); // absent from FEED_V1 yet not deprecated
  });

  it('custom model validation (5.8): bad ids and missing context rejected; pricing optional', async () => {
    await expect(createCustomModel(handle.db, { canonicalId: 'nope' })).rejects.toThrow(/invalid model/);
    const created = await createCustomModel(handle.db, {
      canonicalId: 'ollama/custom-unpriced:7b',
      providerKind: 'local',
      displayName: 'Custom Unpriced',
      contextWindow: 16384,
      capabilities: { tools: true },
    });
    expect(created.source).toBe('custom');
    expect(await pricingAt(handle.db, created.id, new Date())).toBeNull(); // → cost_unknown at ledger time
  });

  it('deprecation references surface policies pointing at retired models (5.7)', async () => {
    // deprecate the local seed model? No — retire a referenced synced model instead:
    // tb policies reference custom models only, so build the reference through a synced one
    const model = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'anthropic/claude-test-1'),
    });
    await handle.db.update(models).set({ status: 'deprecated' }).where(eq(models.id, model!.id));
    const policy = await handle.db.query.policies.findFirst();
    await handle.db
      .update((await import('../db/schema.js')).policies)
      .set({ fallbackChain: [model!.id] })
      .where(eq((await import('../db/schema.js')).policies.id, policy!.id));

    const refs = await findRetiredModelReferences(handle.db);
    expect(refs.some((r) => r.canonicalId === 'anthropic/claude-test-1' && r.role === 'fallback')).toBe(true);
  });
});

describe.skipIf(!url)('updateModel (DB)', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 2);
    return async () => handle.close();
  });

  it('edits base specs + capabilities + pricing on a custom model', async () => {
    const m = await createCustomModel(handle.db, {
      canonicalId: 'ollama/editable:7b',
      providerKind: 'local',
      displayName: 'Editable',
      contextWindow: 8192,
    });
    expect(await pricingAt(handle.db, m.id, new Date())).toBeNull(); // starts cost_unknown

    const updated = await updateModel(handle.db, m.id, {
      displayName: 'Editable v2',
      contextWindow: 65536,
      maxOutput: 4096,
      capabilities: { json_schema: true, tools: true },
      pricing: { inputPerMtok: 0.5, outputPerMtok: 1.5 },
    });
    expect(updated.displayName).toBe('Editable v2');
    expect(updated.contextWindow).toBe(65536);
    expect(updated.maxOutput).toBe(4096);
    expect(effectiveCapabilities(updated)).toMatchObject({ json_schema: true, tools: true });
    const price = await pricingAt(handle.db, m.id, new Date());
    expect(Number(price?.inputPerMtok)).toBe(0.5);
    expect(Number(price?.outputPerMtok)).toBe(1.5);
  });

  it('edits a discovered (provider) model — the placeholder-spec fixup path', async () => {
    const [prov] = await handle.db
      .insert(models)
      .values({
        canonicalId: 'digitalocean/discovered-z',
        providerKind: 'digitalocean',
        displayName: 'discovered-z',
        contextWindow: 8192,
        capabilities: { json_schema: true },
        source: 'provider',
      })
      .returning();
    const updated = await updateModel(handle.db, prov!.id, {
      contextWindow: 131072,
      pricing: { inputPerMtok: 0.65, outputPerMtok: 0.65 },
    });
    expect(updated.contextWindow).toBe(131072);
    expect(updated.source).toBe('provider');
    expect(Number((await pricingAt(handle.db, prov!.id, new Date()))?.inputPerMtok)).toBe(0.65);
  });

  it('rejects base-spec edits on a synced model but allows capability overrides', async () => {
    const [synced] = await handle.db
      .insert(models)
      .values({
        canonicalId: 'openai/synced-fixture',
        providerKind: 'openai_compat',
        displayName: 'synced fixture',
        contextWindow: 128000,
        capabilities: {},
        source: 'synced',
      })
      .returning();
    await expect(updateModel(handle.db, synced!.id, { contextWindow: 999 })).rejects.toThrow(/feed-managed/);
    // capability-only edit is allowed and pins an override that survives sync
    const ok = await updateModel(handle.db, synced!.id, { capabilities: { vision: true } });
    expect(effectiveCapabilities(ok).vision).toBe(true);
    // base spec unchanged by the rejected edit
    expect((await handle.db.query.models.findFirst({ where: eq(models.id, synced!.id) }))?.contextWindow).toBe(
      128000,
    );
  });

  it('rejects unknown fields (strict) and non-existent ids', async () => {
    await expect(updateModel(handle.db, '00000000-0000-0000-0000-000000000000', { contextWindow: 1 })).rejects.toThrow(
      /not found/,
    );
    const anyModel = await handle.db.query.models.findFirst();
    await expect(updateModel(handle.db, anyModel!.id, { bogus: true } as never)).rejects.toThrow(/invalid edit/);
  });
});
