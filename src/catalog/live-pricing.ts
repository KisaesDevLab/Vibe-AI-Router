/**
 * Live pricing feed (Q-101): Anthropic's Models API reports ids, context windows and
 * capabilities but NO prices, so a model discovered from it would cost `cost_unknown` until the
 * next router release refreshed the vendored snapshot. This module fetches LiteLLM's upstream
 * price file and applies it to DISCOVERED rows only.
 *
 * The vendored snapshot stays the pinned source for everything it carries (Q-017). Every write
 * path here is narrower than the vendored sync's:
 * - only rows that already exist with source='provider' — never inserts, never deprecates;
 * - never an id the vendored feed carries (its nightly sync owns those — see loadCuratedIds);
 * - the feed entry's provider kind must match the row's;
 * - a price is applied only when input AND output are both published, finite and non-negative
 *   (a half-priced row would bill half a request as free rather than flag cost_unknown);
 * - context window / max output only fill discovery placeholders;
 * - pricing appends to history only when it differs (5.4).
 *
 * The URL is deployment config (`CATALOG_PRICING_FEED_URL`), not a user-supplied value — not an
 * SSRF surface. The fetch happens only as part of a provider refresh, so an appliance with no
 * linked cloud provider never makes it (invariant 4).
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { models } from '../../db/schema.js';
import { DISCOVERED_CONTEXT_WINDOW } from './discovery.js';
import { appendPricingIfChanged, parseFeed, type SyncedModel } from './sync.js';

/** upstream is ~3 MB; anything far past that is not the file we asked for */
const MAX_FEED_BYTES = 32 * 1024 * 1024;

export type FetchPricingFeed = (url: string, signal: AbortSignal) => Promise<string>;

export const fetchPricingFeed: FetchPricingFeed = async (url, signal) => {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`pricing feed fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_FEED_BYTES) throw new Error('pricing feed fetch failed: payload too large');
  return text;
};

export interface LivePricingReport {
  sourceSha256: string;
  /** discovered rows the feed was allowed to price (source='provider', not vendored-owned) */
  candidates: number;
  matched: number;
  /** canonical ids that got a new pricing history row */
  pricingChanged: string[];
  /** canonical ids whose placeholder context window / unset max output got filled */
  specsUpdated: string[];
}

function usablePrice(p: SyncedModel['pricing']): boolean {
  if (p.inputPerMtok === null || p.outputPerMtok === null) return false;
  return [p.inputPerMtok, p.outputPerMtok, p.cacheReadPerMtok, p.cacheWritePerMtok].every(
    (v) => v === null || (Number.isFinite(Number(v)) && Number(v) >= 0),
  );
}

export async function applyLivePricing(
  db: Db,
  feedText: string,
  opts: { curatedIds: ReadonlySet<string>; now?: Date },
): Promise<LivePricingReport> {
  const raw: unknown = JSON.parse(feedText);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('pricing feed is not a JSON object');
  }
  const byId = new Map(parseFeed(raw as Record<string, unknown>).entries.map((e) => [e.canonicalId, e]));
  const report: LivePricingReport = {
    sourceSha256: createHash('sha256').update(feedText).digest('hex'),
    candidates: 0,
    matched: 0,
    pricingChanged: [],
    specsUpdated: [],
  };
  const now = opts.now ?? new Date();
  const rows = await db.query.models.findMany({ where: eq(models.source, 'provider') });
  for (const row of rows) {
    if (opts.curatedIds.has(row.canonicalId)) continue;
    report.candidates++;
    const entry = byId.get(row.canonicalId);
    if (!entry || entry.providerKind !== row.providerKind) continue;
    report.matched++;

    const set: Partial<typeof models.$inferInsert> = {};
    if (entry.contextWindow !== null && row.contextWindow === DISCOVERED_CONTEXT_WINDOW) {
      set.contextWindow = entry.contextWindow;
    }
    if (entry.maxOutput !== null && row.maxOutput === null) set.maxOutput = entry.maxOutput;
    if (Object.keys(set).length > 0) {
      await db.update(models).set(set).where(eq(models.id, row.id));
      report.specsUpdated.push(row.canonicalId);
    }

    if (usablePrice(entry.pricing) && (await appendPricingIfChanged(db, row.id, entry.pricing, now))) {
      report.pricingChanged.push(row.canonicalId);
    }
  }
  return report;
}
