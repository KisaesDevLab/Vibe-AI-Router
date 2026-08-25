/**
 * Enrich-only curated entries (Q-088): a feed entry with capabilities/pricing but NO context
 * window (DO's kimi-k3 — DO hasn't published its specs) must never create a row or assert base
 * specs; it only enriches a discovered row in place. Guards the two failure modes the design
 * exists to prevent: inventing specs the source doesn't publish, and nightly-clobbering an
 * operator-corrected context window.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type DbHandle } from '../src/db/client.js';
import { resetDb } from './helpers.js';
import { modelPricing, models } from '../db/schema.js';
import { parseFeed, syncCatalog } from '../src/catalog/sync.js';

const ENRICH_ONLY_FEED = {
  'digitalocean/kimi-k3': {
    input_cost_per_token: 0.00000285,
    output_cost_per_token: 0.00001425,
    cache_read_input_token_cost: 0.000000285,
    supports_prompt_caching: true,
    supports_vision: true,
    supports_response_schema: true,
    litellm_provider: 'digitalocean',
    mode: 'chat',
  },
};

describe('parseFeed enrich-only entries (pure)', () => {
  it('keeps a no-context entry that carries capabilities/pricing, with contextWindow null', () => {
    const { entries, skipped } = parseFeed(ENRICH_ONLY_FEED);
    expect(skipped).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      canonicalId: 'digitalocean/kimi-k3',
      contextWindow: null,
      capabilities: { vision: true, json_schema: true, caching: true },
    });
    expect(entries[0]?.pricing.inputPerMtok).toBe('2.85');
    expect(entries[0]?.pricing.outputPerMtok).toBe('14.25');
  });

  it('still skips an entry that has neither specs nor anything to enrich with', () => {
    const { entries, skipped } = parseFeed({
      'digitalocean/empty-shell': { litellm_provider: 'digitalocean', mode: 'chat' },
    });
    expect(entries).toHaveLength(0);
    expect(skipped).toEqual(['digitalocean/empty-shell']);
  });
});

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

describe.skipIf(!url)('syncCatalog enrich-only (DB)', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    await resetDb(url!);
    handle = createDb(url!, 2);
    return async () => handle.close();
  });

  it('never inserts a row for an enrich-only entry', async () => {
    const report = await syncCatalog(handle.db, ENRICH_ONLY_FEED, { source: 'test', sourceSha256: 'x' });
    expect(report.added).toHaveLength(0);
    expect(report.skipped.some((s) => s.startsWith('digitalocean/kimi-k3 (enrich-only'))).toBe(true);
    expect(
      await handle.db.query.models.findFirst({ where: eq(models.canonicalId, 'digitalocean/kimi-k3') }),
    ).toBeUndefined();
  });

  it('enriches a discovered row (caps + pricing) while leaving its base specs alone', async () => {
    // discovery inserted the model with placeholder specs; operator then corrected the context
    const [row] = await handle.db
      .insert(models)
      .values({
        canonicalId: 'digitalocean/kimi-k3',
        providerKind: 'digitalocean',
        displayName: 'kimi-k3',
        contextWindow: 262144, // operator-set, NOT the placeholder
        maxOutput: 131072,
        capabilities: { json_schema: true },
        source: 'provider',
      })
      .returning();

    const report = await syncCatalog(handle.db, ENRICH_ONLY_FEED, { source: 'test', sourceSha256: 'x' });
    expect(report.updated).toContain('digitalocean/kimi-k3');

    const after = await handle.db.query.models.findFirst({ where: eq(models.id, row!.id) });
    expect(after?.contextWindow).toBe(262144); // untouched — the whole point of enrich-only
    expect(after?.maxOutput).toBe(131072);
    expect(after?.capabilities).toMatchObject({ json_schema: true, vision: true, caching: true });
    expect(after?.source).toBe('provider'); // stays operator-editable

    const pricing = await handle.db.query.modelPricing.findMany({
      where: eq(modelPricing.modelId, row!.id),
    });
    expect(pricing).toHaveLength(1);
    expect(Number(pricing[0]!.inputPerMtok)).toBe(2.85);
    expect(Number(pricing[0]!.outputPerMtok)).toBe(14.25);
    expect(Number(pricing[0]!.cacheReadPerMtok)).toBe(0.285);

    // idempotent: same feed again → zero changes (5.9 holds for enrich-only too)
    const again = await syncCatalog(handle.db, ENRICH_ONLY_FEED, { source: 'test', sourceSha256: 'x' });
    expect(again.updated).toHaveLength(0);
    expect(again.pricingChanged).toHaveLength(0);
    expect(
      await handle.db.query.modelPricing.findMany({ where: eq(modelPricing.modelId, row!.id) }),
    ).toHaveLength(1);
  });

  it('the shipped curated file parses with kimi-k3 as its only enrich-only entry', async () => {
    const { loadVendoredFeed } = await import('../src/catalog/sync.js');
    const { feed } = await loadVendoredFeed();
    const { entries } = parseFeed(feed);
    const enrichOnly = entries.filter((e) => e.contextWindow === null);
    expect(enrichOnly.map((e) => e.canonicalId)).toEqual(['digitalocean/kimi-k3']);
    // and every DO entry carries pricing — "capture pricing for each model" is a shipped
    // property of the curated file, not an aspiration
    for (const e of entries.filter((x) => x.providerKind === 'digitalocean')) {
      expect(e.pricing.inputPerMtok, e.canonicalId).not.toBeNull();
      expect(e.pricing.outputPerMtok, e.canonicalId).not.toBeNull();
    }
  });
});
