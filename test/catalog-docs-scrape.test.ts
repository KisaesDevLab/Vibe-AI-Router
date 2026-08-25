/**
 * DO docs scrape (Q-090): parsers run against VENDORED SNAPSHOTS of the real docs pages
 * (test/fixtures/do-docs, retrieved 2026-08-24) so a docs redesign shows up as a fixture
 * refresh + failing test, never as silent bad writes. The apply path asserts the conservative
 * write rules: discovered rows only, additive capabilities, placeholder-only spec fills,
 * append-only pricing.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type DbHandle } from '../src/db/client.js';
import { resetDb } from './helpers.js';
import { modelPricing, models } from '../db/schema.js';
import { DISCOVERED_CONTEXT_WINDOW } from '../src/catalog/discovery.js';
import {
  applyScrapedToCatalog,
  capabilitiesFromNotes,
  parseModelsPage,
  parsePricingPage,
  scrapeDoDocs,
  type FetchPage,
} from '../src/catalog/do-docs.js';

const fixture = (name: string): Promise<string> =>
  readFile(join(import.meta.dirname, 'fixtures', 'do-docs', name), 'utf8');

const fixtureFetch: FetchPage = async (url) => fixture(url.includes('pricing') ? 'pricing.html' : 'models.html');

describe('parseModelsPage (fixture)', () => {
  let html: string;
  beforeAll(async () => {
    html = await fixture('models.html');
  });

  it('extracts model ids, specs, and capability phrases from the real page', () => {
    const parsed = parseModelsPage(html);
    const byId = new Map(parsed.map((m) => [m.modelId, m]));

    // kimi-k3: specs unpublished, capabilities published
    const k3 = byId.get('kimi-k3');
    expect(k3).toBeDefined();
    expect(k3?.displayName).toBe('Kimi K3');
    expect(k3?.contextWindow).toBeNull(); // "Not published" never parses to a number
    expect(k3?.maxOutput).toBeNull();
    expect(k3?.capabilities['vision']).toBe(true); // "Native vision (text, images)"
    expect(k3?.capabilities['caching']).toBe(true); // "Prompt caching"

    // kimi-k2.6: full specs
    const k26 = byId.get('kimi-k2.6');
    expect(k26?.contextWindow).toBe(262144);
    expect(k26?.maxOutput).toBe(262144);
    expect(k26?.capabilities['caching']).toBe(true);

    // a reasonable slice of the page parses (67 chat rows at snapshot time)
    expect(parsed.length).toBeGreaterThan(50);
    // "Not published" / "Not Applicable" cells never leak through as numbers anywhere
    for (const m of parsed) {
      if (m.contextWindow !== null) expect(m.contextWindow).toBeGreaterThanOrEqual(1024);
    }
  });

  it('maps DO capability phrasing to internal capability keys', () => {
    expect(capabilitiesFromNotes('✔️ Native vision (text, images) ✔️ Prompt caching')).toEqual({
      vision: true,
      caching: true,
    });
    expect(capabilitiesFromNotes('Tool (function) calling · Structured outputs · Reasoning')).toEqual({
      tools: true,
      json_schema: true,
      reasoning: true,
    });
    expect(capabilitiesFromNotes('Adaptive thinking (API default: on)')).toEqual({ reasoning: true });
    // absence detects NOTHING — the additive apply step can then never turn a capability off
    expect(capabilitiesFromNotes('Use is subject to the model license.')).toEqual({});
  });
});

describe('parsePricingPage (fixture)', () => {
  it('captures per-MTok input/output/cache pricing keyed by display name', async () => {
    const pricing = parsePricingPage(await fixture('pricing.html'));
    expect(pricing.get('kimi k3')).toEqual({
      inputPerMtok: '2.85',
      outputPerMtok: '14.25',
      cacheReadPerMtok: '0.285',
    });
    expect(pricing.get('kimi k2.6')).toEqual({
      inputPerMtok: '0.95',
      outputPerMtok: '4.00',
      cacheReadPerMtok: '0.19',
    });
    // non-token pricing shapes (image models etc.) must be skipped, not misread
    for (const p of pricing.values()) {
      expect(Number(p.inputPerMtok)).toBeGreaterThan(0);
      expect(Number(p.outputPerMtok)).toBeGreaterThan(0);
    }
  });
});

describe('scrapeDoDocs (fixture join)', () => {
  it('joins specs and pricing on display name', async () => {
    const scraped = await scrapeDoDocs(fixtureFetch, AbortSignal.timeout(5000));
    const k3 = scraped.find((m) => m.modelId === 'kimi-k3');
    expect(k3?.pricing).toEqual({ inputPerMtok: '2.85', outputPerMtok: '14.25', cacheReadPerMtok: '0.285' });
    // the whole Kimi family joins, and pricing capture reaches well beyond it (20 models
    // joined at snapshot time — display names that differ between the two pages don't join,
    // which is safe: no pricing beats guessed pricing)
    for (const id of ['kimi-k2.5', 'kimi-k2.6']) {
      expect(scraped.find((m) => m.modelId === id)?.pricing, id).not.toBeNull();
    }
    const priced = scraped.filter((m) => m.pricing !== null);
    expect(priced.length).toBeGreaterThanOrEqual(15);
  });
});

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

describe.skipIf(!url)('applyScrapedToCatalog (DB)', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    await resetDb(url!);
    handle = createDb(url!, 2);
    return async () => handle.close();
  });

  it('enriches discovered rows only; fills placeholders; appends pricing; is idempotent', async () => {
    // a discovered row with placeholder specs + Q-083 default caps, and a curated (synced) row
    await handle.db.insert(models).values([
      {
        canonicalId: 'digitalocean/kimi-k3',
        providerKind: 'digitalocean',
        displayName: 'kimi-k3',
        contextWindow: DISCOVERED_CONTEXT_WINDOW,
        capabilities: { json_schema: true },
        source: 'provider',
      },
      {
        canonicalId: 'digitalocean/kimi-k2.6',
        providerKind: 'digitalocean',
        displayName: 'kimi-k2.6',
        contextWindow: 262144,
        capabilities: { json_schema: true, vision: true, caching: true },
        source: 'synced',
      },
    ]);

    const scraped = await scrapeDoDocs(fixtureFetch, AbortSignal.timeout(5000));
    const report = await applyScrapedToCatalog(handle.db, scraped);

    // discovered row gained the docs' capabilities ADDITIVELY and its pricing
    const k3 = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'digitalocean/kimi-k3'),
    });
    expect(k3?.capabilities).toMatchObject({ json_schema: true, vision: true, caching: true });
    expect(k3?.contextWindow).toBe(DISCOVERED_CONTEXT_WINDOW); // docs publish none — placeholder stays
    const k3Pricing = await handle.db.query.modelPricing.findMany({
      where: eq(modelPricing.modelId, k3!.id),
    });
    expect(k3Pricing).toHaveLength(1);
    expect(Number(k3Pricing[0]!.inputPerMtok)).toBe(2.85);
    expect(Number(k3Pricing[0]!.outputPerMtok)).toBe(14.25);
    expect(report.capabilitiesUpdated).toContain('digitalocean/kimi-k3');
    expect(report.pricingChanged).toContain('digitalocean/kimi-k3');

    // curated row untouched — the vendored feed owns it
    expect(report.skippedCurated).toContain('digitalocean/kimi-k2.6');
    const k26Pricing = await handle.db.query.modelPricing.findMany({
      where: eq(
        modelPricing.modelId,
        (await handle.db.query.models.findFirst({
          where: eq(models.canonicalId, 'digitalocean/kimi-k2.6'),
        }))!.id,
      ),
    });
    expect(k26Pricing).toHaveLength(0);

    // second run: nothing differs → no new pricing rows, no cap changes
    const report2 = await applyScrapedToCatalog(handle.db, scraped);
    expect(report2.capabilitiesUpdated).toHaveLength(0);
    expect(report2.pricingChanged).toHaveLength(0);
    expect(
      await handle.db.query.modelPricing.findMany({ where: eq(modelPricing.modelId, k3!.id) }),
    ).toHaveLength(1);
  });

  it('fills a scraped context window only while the discovery placeholder is still in place', async () => {
    await handle.db.insert(models).values({
      canonicalId: 'digitalocean/kimi-k2.5',
      providerKind: 'digitalocean',
      displayName: 'kimi-k2.5',
      contextWindow: 999, // operator-corrected value — NOT the placeholder
      capabilities: {},
      source: 'provider',
    });
    const scraped = await scrapeDoDocs(fixtureFetch, AbortSignal.timeout(5000));
    await applyScrapedToCatalog(handle.db, scraped);
    const row = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'digitalocean/kimi-k2.5'),
    });
    expect(row?.contextWindow).toBe(999); // operator edit survives the scrape
    expect(row?.capabilities).toMatchObject({ caching: true }); // caps still enrich
  });
});
