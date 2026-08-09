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
  DISCOVERED_CONTEXT_WINDOW,
  discoverDigitalOceanModels,
  planDiscovery,
} from '../src/catalog/discovery.js';

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
    expect(added?.capabilities).toEqual({});
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
  });
});
