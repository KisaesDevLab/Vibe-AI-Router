/**
 * Provider model auto-discovery (Q-082): the pure planner + the DB-backed insert path.
 * Asserts discovery is ADDITIVE (adds only unknown ids), CONSERVATIVE (source='provider',
 * placeholder context window, no capabilities, no pricing → cost_unknown), NON-DESTRUCTIVE
 * (never overwrites a curated/synced row), and IDEMPOTENT (a second run adds nothing).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type DbHandle } from '../src/db/client.js';
import { resetDb } from './helpers.js';
import { modelPricing, models, providers } from '../db/schema.js';
import {
  DISCOVERED_CAPABILITIES,
  DISCOVERED_CONTEXT_WINDOW,
  discoverDigitalOceanModels,
  planDiscovery,
  thirdPartyHostingFor,
} from '../src/catalog/discovery.js';
import { updateModel } from '../src/catalog/service.js';

describe('planDiscovery (pure)', () => {
  it('normalizes bare + namespaced ids, splits new vs known, dedupes, skips junk', () => {
    const existing = new Set(['digitalocean/known-a']);
    const plan = planDiscovery(
      ['known-a', 'digitalocean/known-a', 'new-b', 'digitalocean/new-c', '', 42, '  '],
      existing,
    );
    // both the bare and namespaced spellings of known-a collapse to one already-known id
    expect(plan.alreadyKnown).toEqual(['digitalocean/known-a']);
    expect(plan.toInsert.map((t) => t.canonicalId).sort()).toEqual([
      'digitalocean/new-b',
      'digitalocean/new-c',
    ]);
    // displayName is the native id without the namespace
    expect(plan.toInsert.find((t) => t.canonicalId === 'digitalocean/new-c')?.displayName).toBe('new-c');
    // '', the number, and the whitespace-only entry are all skipped (never inserted)
    expect(plan.skipped).toHaveLength(3);
  });

  it('tags third-party-hosted ids (Q-098): anthropic-*/openai-* yes, open-weight gpt-oss and OSS models no', () => {
    expect(thirdPartyHostingFor('anthropic-claude-sonnet-4.6')?.vendor).toBe('anthropic');
    expect(thirdPartyHostingFor('anthropic-claude-fable-5.1')?.retentionNote).toMatch(/30-day/);
    expect(thirdPartyHostingFor('openai-gpt-5.4')?.vendor).toBe('openai');
    expect(thirdPartyHostingFor('openai-o3')?.vendor).toBe('openai');
    // DO-hosted open-weight family — NOT third party (already in the curated file)
    expect(thirdPartyHostingFor('openai-gpt-oss-120b')).toBeUndefined();
    expect(thirdPartyHostingFor('openai-gpt-oss-20b')).toBeUndefined();
    expect(thirdPartyHostingFor('glm-5.3-flash')).toBeUndefined();
    expect(thirdPartyHostingFor('qwen3.5-397b-a17b')).toBeUndefined();

    const plan = planDiscovery(
      ['anthropic-claude-opus-5', 'digitalocean/openai-gpt-5', 'openai-gpt-oss-20b', 'glm-5.3'],
      new Set(),
    );
    const byId = new Map(plan.toInsert.map((t) => [t.canonicalId, t.thirdPartyHosted]));
    expect(byId.get('digitalocean/anthropic-claude-opus-5')?.vendor).toBe('anthropic');
    expect(byId.get('digitalocean/openai-gpt-5')?.vendor).toBe('openai');
    expect(byId.get('digitalocean/openai-gpt-oss-20b')).toBeUndefined();
    expect(byId.get('digitalocean/glm-5.3')).toBeUndefined();
  });
});

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

describe.skipIf(!url)('discoverDigitalOceanModels (DB)', () => {
  let handle: DbHandle;
  let providerId: string;

  beforeAll(async () => {
    await resetDb(url!);
    handle = createDb(url!, 2);
    const firm = await handle.db.query.firms.findFirst();
    const [p] = await handle.db
      .insert(providers)
      .values({
        firmId: firm!.id,
        kind: 'digitalocean',
        label: 'DO test',
        baseUrl: 'https://inference.do-ai.run/v1',
        authType: 'api_key',
      })
      .returning();
    providerId = p!.id;
    return async () => handle.close();
  });

  it('adds unknown models conservatively, leaves existing rows untouched, is idempotent', async () => {
    // a pre-existing curated (synced) row the discovery must NOT overwrite
    await handle.db
      .insert(models)
      .values({
        canonicalId: 'digitalocean/curated-x',
        providerKind: 'digitalocean',
        displayName: 'curated-x',
        contextWindow: 128000,
        capabilities: { tools: true },
        source: 'synced',
      })
      .onConflictDoNothing();

    const provider = await handle.db.query.providers.findFirst({ where: eq(providers.id, providerId) });
    const listIds = (): Promise<string[]> => Promise.resolve(['curated-x', 'brand-new-y']);

    const res = await discoverDigitalOceanModels(handle.db, provider!, 'key', { listIds });
    expect(res.discovered).toEqual(['digitalocean/brand-new-y']);
    expect(res.alreadyKnown).toBe(1);

    // the new row: source='provider', conservative specs, no pricing (cost_unknown)
    const added = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'digitalocean/brand-new-y'),
    });
    expect(added?.source).toBe('provider');
    expect(added?.providerKind).toBe('digitalocean');
    expect(added?.contextWindow).toBe(DISCOVERED_CONTEXT_WINDOW);
    // json_schema-capable by default (Q-083) so it's selectable for cloud JSON classes
    expect(added?.capabilities).toEqual(DISCOVERED_CAPABILITIES);
    expect(added?.capabilities).toEqual({ json_schema: true });
    const pricing = await handle.db.query.modelPricing.findMany({
      where: eq(modelPricing.modelId, added!.id),
    });
    expect(pricing).toHaveLength(0);

    // curated row untouched
    const curated = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'digitalocean/curated-x'),
    });
    expect(curated?.source).toBe('synced');
    expect(curated?.contextWindow).toBe(128000);
    expect(curated?.capabilities).toEqual({ tools: true });

    // second run over the same served set adds nothing
    const res2 = await discoverDigitalOceanModels(handle.db, provider!, 'key', { listIds });
    expect(res2.discovered).toEqual([]);
    expect(res2.alreadyKnown).toBe(2);
    expect(res2.thirdPartyHosted).toEqual([]);
  });

  it('flags third-party-hosted rows on insert AND re-tags pre-0007 rows in place (Q-098)', async () => {
    // a row discovered BEFORE the flag existed — plain digitalocean/… with no tag
    await handle.db
      .insert(models)
      .values({
        canonicalId: 'digitalocean/anthropic-claude-sonnet-4.6',
        providerKind: 'digitalocean',
        displayName: 'anthropic-claude-sonnet-4.6',
        contextWindow: 200000, // operator-corrected spec — must survive re-tagging
        capabilities: { json_schema: true },
        capabilityOverrides: { vision: true },
        source: 'provider',
      })
      .onConflictDoNothing();

    const provider = await handle.db.query.providers.findFirst({ where: eq(providers.id, providerId) });
    const listIds = (): Promise<string[]> =>
      Promise.resolve(['anthropic-claude-sonnet-4.6', 'openai-gpt-5.4', 'openai-gpt-oss-120b', 'glm-5.3']);

    const res = await discoverDigitalOceanModels(handle.db, provider!, 'key', { listIds });
    expect(res.discovered.sort()).toEqual([
      'digitalocean/glm-5.3',
      'digitalocean/openai-gpt-5.4',
      'digitalocean/openai-gpt-oss-120b',
    ]);
    expect(res.thirdPartyHosted.sort()).toEqual([
      'digitalocean/anthropic-claude-sonnet-4.6',
      'digitalocean/openai-gpt-5.4',
    ]);

    const claude = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'digitalocean/anthropic-claude-sonnet-4.6'),
    });
    expect(claude?.thirdPartyHosted).toBe(true);
    expect(claude?.retentionNote).toMatch(/Anthropic's terms/);
    // re-tagging touched ONLY the flag columns
    expect(claude?.contextWindow).toBe(200000);
    expect(claude?.capabilityOverrides).toEqual({ vision: true });

    const gpt = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'digitalocean/openai-gpt-5.4'),
    });
    expect(gpt?.thirdPartyHosted).toBe(true);
    expect(gpt?.retentionNote).toMatch(/OpenAI's terms/);
    // still admitted — tagged, never filtered
    expect(gpt?.source).toBe('provider');

    for (const id of ['digitalocean/openai-gpt-oss-120b', 'digitalocean/glm-5.3']) {
      const row = await handle.db.query.models.findFirst({ where: eq(models.canonicalId, id) });
      expect(row?.thirdPartyHosted).toBe(false);
      expect(row?.retentionNote).toBeNull();
    }

    // an operator edit through the catalog service never clears the flag
    await updateModel(handle.db, gpt!.id, { contextWindow: 400000 });
    const edited = await handle.db.query.models.findFirst({ where: eq(models.id, gpt!.id) });
    expect(edited?.contextWindow).toBe(400000);
    expect(edited?.thirdPartyHosted).toBe(true);

    // idempotent: a second run changes nothing and reports the same set
    const res2 = await discoverDigitalOceanModels(handle.db, provider!, 'key', { listIds });
    expect(res2.discovered).toEqual([]);
    expect(res2.thirdPartyHosted.sort()).toEqual(res.thirdPartyHosted.sort());
  });
});
