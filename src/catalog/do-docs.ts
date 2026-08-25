/**
 * DigitalOcean docs scrape (Q-090): DO's inference API reports model IDS only (Q-082) — the
 * per-model capabilities, context windows, and pricing live exclusively in human-readable HTML
 * tables on docs.digitalocean.com. This module parses those two pages and applies what they
 * publish to DISCOVERED catalog rows, so an operator doesn't have to transcribe the docs into
 * capability overrides by hand.
 *
 * Scraping is inherently fragile, so every write path is conservative:
 * - only rows the catalog already has (via discovery) are touched — never inserts;
 * - only source='provider' rows — 'synced' rows belong to the vendored curated feed and
 *   'custom' rows to the operator;
 * - capabilities are ADDITIVE into the base capability set (a phrase we fail to find never
 *   turns a capability off), and capability_overrides always win regardless (5.5);
 * - specs fill placeholders only: context window is set only while the row still carries the
 *   discovery placeholder, max output only while unset — operator edits are never clobbered;
 * - pricing appends to the model_pricing history only when it differs (append-only, 5.4).
 * A page-format change therefore degrades to "nothing matched", never to wrong data.
 *
 * The fetch targets are FIXED constants on docs.digitalocean.com (no user-supplied URL — not
 * an SSRF surface), and the scrape runs only when an operator triggers it from the admin UI.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { modelPricing, models } from '../../db/schema.js';
import { DISCOVERED_CONTEXT_WINDOW } from './discovery.js';

export const DO_DOCS_MODELS_URL = 'https://docs.digitalocean.com/products/inference/details/models/';
export const DO_DOCS_PRICING_URL = 'https://docs.digitalocean.com/products/inference/details/pricing/';

export type FetchPage = (url: string, signal: AbortSignal) => Promise<string>;

export const fetchDocsPage: FetchPage = async (url, signal) => {
  const res = await fetch(url, { headers: { accept: 'text/html' }, signal });
  if (!res.ok) throw new Error(`DO docs fetch failed: HTTP ${res.status} for ${url}`);
  return res.text();
};

export interface ScrapedModel {
  /** native DO model id (`kimi-k3`) — catalog canonical id is `digitalocean/<id>` */
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutput: number | null;
  /** only keys positively detected in the docs — absence means "not stated", never false */
  capabilities: Record<string, boolean>;
  /** USD per MTok, decimal strings (model_pricing format); null when the page has no row */
  pricing: { inputPerMtok: string; outputPerMtok: string; cacheReadPerMtok: string | null } | null;
}

// ── HTML table extraction (no HTML parser dependency — DO docs are static Hugo tables) ──────

const stripTags = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

interface HtmlTable {
  headers: string[];
  rows: string[][];
}

export function extractTables(html: string): HtmlTable[] {
  const tables: HtmlTable[] = [];
  for (const [, tbl] of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const headers = [...tbl!.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => stripTags(m[1]!));
    const rows: string[][] = [];
    for (const [, tr] of tbl!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...tr!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]!));
      if (cells.length > 0) rows.push(cells);
    }
    if (headers.length > 0 && rows.length > 0) tables.push({ headers, rows });
  }
  return tables;
}

const parseTokenCount = (cell: string | undefined): number | null => {
  if (!cell) return null;
  const m = /^([\d,]+)( tokens)?$/.exec(cell.trim());
  if (!m) return null; // "Not published", "Not Applicable", prose…
  const n = Number(m[1]!.replace(/,/g, ''));
  // a bare "100" or "256" is an image-model pixel/char figure, not a context window
  return Number.isSafeInteger(n) && n >= 1024 ? n : null;
};

/** capability phrases as DO's docs actually word them (fixture-tested against the live page) */
const CAPABILITY_PATTERNS: Record<string, RegExp> = {
  vision: /native vision|text, images/i,
  tools: /tool\s*(\(function\)\s*)?calling/i,
  json_schema: /structured outputs?/i,
  caching: /prompt caching/i,
  reasoning: /adaptive thinking|\breasoning\b/i,
};

export function capabilitiesFromNotes(notes: string): Record<string, boolean> {
  const caps: Record<string, boolean> = {};
  for (const [key, pattern] of Object.entries(CAPABILITY_PATTERNS)) {
    if (pattern.test(notes)) caps[key] = true;
  }
  return caps;
}

const nameKey = (name: string): string => name.toLowerCase().replace(/\s+/g, ' ').trim();

/** Models page → specs + capabilities (tables carrying both a Model ID and a Context Window column). */
export function parseModelsPage(html: string): Omit<ScrapedModel, 'pricing'>[] {
  const out = new Map<string, Omit<ScrapedModel, 'pricing'>>();
  for (const table of extractTables(html)) {
    const idCol = table.headers.indexOf('Model ID');
    const ctxCol = table.headers.indexOf('Context Window');
    if (idCol === -1 || ctxCol === -1) continue;
    const nameCol = table.headers.indexOf('Model');
    const maxCol = table.headers.indexOf('Max Output Tokens');
    const notesCol = table.headers.indexOf('Usage Notes');
    for (const row of table.rows) {
      const modelId = row[idCol]?.trim();
      if (!modelId || /\s/.test(modelId)) continue; // a real id is a single slug
      if (out.has(modelId)) continue;
      out.set(modelId, {
        modelId,
        displayName: (nameCol !== -1 ? row[nameCol] : undefined)?.trim() || modelId,
        contextWindow: parseTokenCount(row[ctxCol]),
        maxOutput: maxCol !== -1 ? parseTokenCount(row[maxCol]) : null,
        capabilities: notesCol !== -1 ? capabilitiesFromNotes(row[notesCol] ?? '') : {},
      });
    }
  }
  return [...out.values()];
}

/**
 * Pricing page → display name → per-MTok prices. The pricing tables carry no Model ID column,
 * so the join to specs happens on the display name. Only the exact input/output token pattern
 * is accepted — image/audio/per-request pricing shapes are skipped rather than misread.
 */
export function parsePricingPage(html: string): Map<string, NonNullable<ScrapedModel['pricing']>> {
  const out = new Map<string, NonNullable<ScrapedModel['pricing']>>();
  const pattern =
    /Input\/output tokens\s*\$([\d.]+)\s*per 1M tokens\s*\$([\d.]+)\s*per 1M tokens(?:.*?Prompt caching\s*\$([\d.]+)\s*per 1M tokens)?/i;
  for (const table of extractTables(html)) {
    const nameCol = table.headers.indexOf('Model');
    const priceCol = table.headers.findIndex((h) => /inference/i.test(h));
    if (nameCol === -1 || priceCol === -1) continue;
    for (const row of table.rows) {
      const name = row[nameCol]?.trim();
      const m = row[priceCol] ? pattern.exec(row[priceCol]) : null;
      if (!name || !m || out.has(nameKey(name))) continue;
      out.set(nameKey(name), {
        inputPerMtok: m[1]!,
        outputPerMtok: m[2]!,
        cacheReadPerMtok: m[3] ?? null,
      });
    }
  }
  return out;
}

/** Fetch + parse + join both pages. Pure aside from the injected fetch. */
export async function scrapeDoDocs(fetchPage: FetchPage, signal: AbortSignal): Promise<ScrapedModel[]> {
  const [modelsHtml, pricingHtml] = await Promise.all([
    fetchPage(DO_DOCS_MODELS_URL, signal),
    fetchPage(DO_DOCS_PRICING_URL, signal),
  ]);
  const pricing = parsePricingPage(pricingHtml);
  return parseModelsPage(modelsHtml).map((m) => ({
    ...m,
    pricing: pricing.get(nameKey(m.displayName)) ?? null,
  }));
}

export interface ScrapeReport {
  scraped: number;
  matched: number;
  /** canonical ids whose base capabilities gained at least one key */
  capabilitiesUpdated: string[];
  /** canonical ids whose placeholder context window / unset max output got filled */
  specsUpdated: string[];
  /** canonical ids that got a new pricing history row */
  pricingChanged: string[];
  /** matched rows left alone because the curated feed or the operator owns them */
  skippedCurated: string[];
  unmatched: number;
}

export async function applyScrapedToCatalog(db: Db, scraped: ScrapedModel[]): Promise<ScrapeReport> {
  const report: ScrapeReport = {
    scraped: scraped.length,
    matched: 0,
    capabilitiesUpdated: [],
    specsUpdated: [],
    pricingChanged: [],
    skippedCurated: [],
    unmatched: 0,
  };
  for (const entry of scraped) {
    const canonicalId = `digitalocean/${entry.modelId}`;
    const row = await db.query.models.findFirst({ where: eq(models.canonicalId, canonicalId) });
    if (!row) {
      report.unmatched++;
      continue;
    }
    report.matched++;
    if (row.source !== 'provider') {
      report.skippedCurated.push(canonicalId);
      continue;
    }

    // capabilities: additive into the base set — detected-true only, never unset
    const baseCaps = { ...((row.capabilities ?? {}) as Record<string, boolean>) };
    let capsChanged = false;
    for (const [key, val] of Object.entries(entry.capabilities)) {
      if (val && baseCaps[key] !== true) {
        baseCaps[key] = true;
        capsChanged = true;
      }
    }

    // specs: fill discovery placeholders only, so operator-corrected values survive
    const set: Partial<typeof models.$inferInsert> = {};
    if (entry.contextWindow !== null && row.contextWindow === DISCOVERED_CONTEXT_WINDOW) {
      set.contextWindow = entry.contextWindow;
    }
    if (entry.maxOutput !== null && row.maxOutput === null) set.maxOutput = entry.maxOutput;
    if (capsChanged) set.capabilities = baseCaps;
    if (Object.keys(set).length > 0) {
      await db.update(models).set(set).where(eq(models.id, row.id));
      if (capsChanged) report.capabilitiesUpdated.push(canonicalId);
      if (set.contextWindow !== undefined || set.maxOutput !== undefined) report.specsUpdated.push(canonicalId);
    }

    if (entry.pricing) {
      const latest = await db.query.modelPricing.findFirst({
        where: eq(modelPricing.modelId, row.id),
        orderBy: (p, { desc }) => desc(p.effectiveFrom),
      });
      const numEq = (a: string | null, b: string | null): boolean =>
        a === null || b === null ? a === b : Number(a) === Number(b);
      const differs =
        !latest ||
        !numEq(latest.inputPerMtok, entry.pricing.inputPerMtok) ||
        !numEq(latest.outputPerMtok, entry.pricing.outputPerMtok) ||
        !numEq(latest.cacheReadPerMtok, entry.pricing.cacheReadPerMtok);
      if (differs) {
        await db.insert(modelPricing).values({
          modelId: row.id,
          effectiveFrom: new Date(),
          inputPerMtok: entry.pricing.inputPerMtok,
          outputPerMtok: entry.pricing.outputPerMtok,
          cacheReadPerMtok: entry.pricing.cacheReadPerMtok,
          cacheWritePerMtok: null,
        });
        report.pricingChanged.push(canonicalId);
      }
    }
  }
  return report;
}
