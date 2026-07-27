/**
 * Catalog sync (5.2–5.5): vendored LiteLLM feed → models + model_pricing.
 * ADDITIVE + FLAGGING ONLY: never deletes; models missing from the feed are marked deprecated.
 * capability_overrides are never touched by sync (5.5). Pricing appends to history (5.4).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { and, eq, inArray, not } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { modelPricing, models } from '../../db/schema.js';

const VENDORED_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../data/litellm-prices.json');

const litellmEntry = z
  .object({
    max_tokens: z.number().optional(),
    max_input_tokens: z.number().optional(),
    max_output_tokens: z.number().optional(),
    input_cost_per_token: z.number().optional(),
    output_cost_per_token: z.number().optional(),
    cache_read_input_token_cost: z.number().optional(),
    cache_creation_input_token_cost: z.number().optional(),
    litellm_provider: z.string(),
    mode: z.string().optional(),
    supports_function_calling: z.boolean().optional(),
    supports_vision: z.boolean().optional(),
    supports_response_schema: z.boolean().optional(),
    supports_prompt_caching: z.boolean().optional(),
    supports_reasoning: z.boolean().optional(),
    deprecation_date: z.string().optional(),
  })
  .passthrough();

const PROVIDER_TO_KIND: Record<string, 'openai_compat' | 'anthropic' | 'local'> = {
  openai: 'openai_compat',
  azure: 'openai_compat',
  groq: 'openai_compat',
  deepseek: 'openai_compat',
  anthropic: 'anthropic',
  ollama: 'local',
};

export interface SyncedModel {
  canonicalId: string;
  providerKind: 'openai_compat' | 'anthropic' | 'local';
  displayName: string;
  contextWindow: number;
  maxOutput: number | null;
  capabilities: Record<string, boolean>;
  deprecationDate: string | null;
  pricing: {
    inputPerMtok: string | null;
    outputPerMtok: string | null;
    cacheReadPerMtok: string | null;
    cacheWritePerMtok: string | null;
  };
}

export interface DiffReport {
  source: string;
  sourceSha256: string;
  added: string[];
  updated: string[];
  pricingChanged: string[];
  deprecated: string[];
  skipped: string[];
  unchanged: number;
}

function perMtok(perToken: number | undefined): string | null {
  if (perToken === undefined) return null;
  // avoid float artifacts: work in micro-dollars per token → dollars per MTok is exact math
  return String(Number((perToken * 1_000_000).toPrecision(12)));
}

/** Parse a raw LiteLLM-shaped feed into internal rows. Pure. */
export function parseFeed(feed: Record<string, unknown>): { entries: SyncedModel[]; skipped: string[] } {
  const entries: SyncedModel[] = [];
  const skipped: string[] = [];
  for (const [key, raw] of Object.entries(feed)) {
    if (key === 'sample_spec') continue;
    const parsed = litellmEntry.safeParse(raw);
    if (!parsed.success) {
      skipped.push(key);
      continue;
    }
    const e = parsed.data;
    if (e.mode !== undefined && e.mode !== 'chat') {
      skipped.push(key);
      continue;
    }
    const kind = PROVIDER_TO_KIND[e.litellm_provider];
    if (!kind) {
      skipped.push(key);
      continue;
    }
    const contextWindow = e.max_input_tokens ?? e.max_tokens;
    if (!contextWindow) {
      skipped.push(key);
      continue;
    }
    const canonicalId = key.includes('/') ? key : `${e.litellm_provider}/${key}`;
    entries.push({
      canonicalId,
      providerKind: kind,
      displayName: key.includes('/') ? (key.split('/').pop() ?? key) : key,
      contextWindow,
      maxOutput: e.max_output_tokens ?? null,
      capabilities: {
        ...(e.supports_function_calling !== undefined ? { tools: e.supports_function_calling } : {}),
        ...(e.supports_response_schema !== undefined ? { json_schema: e.supports_response_schema } : {}),
        ...(e.supports_vision !== undefined ? { vision: e.supports_vision } : {}),
        ...(e.supports_prompt_caching !== undefined ? { caching: e.supports_prompt_caching } : {}),
        ...(e.supports_reasoning !== undefined ? { reasoning: e.supports_reasoning } : {}),
      },
      deprecationDate: e.deprecation_date ?? null,
      pricing: {
        inputPerMtok: perMtok(e.input_cost_per_token),
        outputPerMtok: perMtok(e.output_cost_per_token),
        cacheReadPerMtok: perMtok(e.cache_read_input_token_cost),
        cacheWritePerMtok: perMtok(e.cache_creation_input_token_cost),
      },
    });
  }
  return { entries, skipped };
}

export async function loadVendoredFeed(): Promise<{ feed: Record<string, unknown>; sha256: string }> {
  const text = await readFile(VENDORED_PATH, 'utf8');
  return {
    feed: JSON.parse(text) as Record<string, unknown>,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

function numEq(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Number(a) === Number(b);
}

/** key-order-insensitive comparison — Postgres jsonb does not preserve key order */
function jsonEq(a: unknown, b: unknown): boolean {
  const stable = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  };
  return stable(a) === stable(b);
}

/** Runs a sync. Idempotent: same feed twice → zero changes on the second run (5.9). */
export async function syncCatalog(
  db: Db,
  feed: Record<string, unknown>,
  opts: { source: string; sourceSha256: string; now?: Date },
): Promise<DiffReport> {
  const now = opts.now ?? new Date();
  const { entries, skipped } = parseFeed(feed);
  const report: DiffReport = {
    source: opts.source,
    sourceSha256: opts.sourceSha256,
    added: [],
    updated: [],
    pricingChanged: [],
    deprecated: [],
    skipped,
    unchanged: 0,
  };

  const existing = await db.query.models.findMany();
  const byCanonical = new Map(existing.map((m) => [m.canonicalId, m]));
  const feedIds = new Set(entries.map((e) => e.canonicalId));

  for (const entry of entries) {
    const current = byCanonical.get(entry.canonicalId);

    if (current && current.source === 'custom') {
      // custom rows are operator-owned; sync never touches them
      report.unchanged++;
      continue;
    }

    let modelId: string;
    if (!current) {
      const [inserted] = await db
        .insert(models)
        .values({
          canonicalId: entry.canonicalId,
          providerKind: entry.providerKind,
          displayName: entry.displayName,
          contextWindow: entry.contextWindow,
          maxOutput: entry.maxOutput,
          capabilities: entry.capabilities,
          deprecationDate: entry.deprecationDate,
          source: 'synced',
        })
        .returning();
      if (!inserted) throw new Error(`insert failed: ${entry.canonicalId}`);
      modelId = inserted.id;
      report.added.push(entry.canonicalId);
    } else {
      modelId = current.id;
      const changed =
        current.contextWindow !== entry.contextWindow ||
        (current.maxOutput ?? null) !== entry.maxOutput ||
        !jsonEq(current.capabilities, entry.capabilities) ||
        (current.deprecationDate ?? null) !== entry.deprecationDate ||
        current.status === 'deprecated'; // model returned to the feed → reactivate
      if (changed) {
        await db
          .update(models)
          .set({
            contextWindow: entry.contextWindow,
            maxOutput: entry.maxOutput,
            capabilities: entry.capabilities, // capability_overrides deliberately untouched (5.5)
            deprecationDate: entry.deprecationDate,
            status: 'active',
          })
          .where(eq(models.id, current.id));
        report.updated.push(entry.canonicalId);
      }
    }

    // pricing: append-only history — write only when the latest row differs (5.4)
    const latest = await db.query.modelPricing.findFirst({
      where: eq(modelPricing.modelId, modelId),
      orderBy: (p, { desc }) => desc(p.effectiveFrom),
    });
    const p = entry.pricing;
    const differs =
      !latest ||
      !numEq(latest.inputPerMtok, p.inputPerMtok) ||
      !numEq(latest.outputPerMtok, p.outputPerMtok) ||
      !numEq(latest.cacheReadPerMtok, p.cacheReadPerMtok) ||
      !numEq(latest.cacheWritePerMtok, p.cacheWritePerMtok);
    const hasAnyPrice =
      p.inputPerMtok !== null ||
      p.outputPerMtok !== null ||
      p.cacheReadPerMtok !== null ||
      p.cacheWritePerMtok !== null;
    if (differs && hasAnyPrice) {
      await db.insert(modelPricing).values({
        modelId,
        effectiveFrom: now,
        inputPerMtok: p.inputPerMtok,
        outputPerMtok: p.outputPerMtok,
        cacheReadPerMtok: p.cacheReadPerMtok,
        cacheWritePerMtok: p.cacheWritePerMtok,
      });
      report.pricingChanged.push(entry.canonicalId);
    } else if (
      byCanonical.has(entry.canonicalId) &&
      !report.updated.includes(entry.canonicalId) &&
      !report.added.includes(entry.canonicalId)
    ) {
      report.unchanged++;
    }
  }

  // flag synced models that vanished from the feed — never delete (5.3)
  const vanished = existing.filter(
    (m) => m.source === 'synced' && m.status === 'active' && !feedIds.has(m.canonicalId),
  );
  if (vanished.length > 0) {
    await db
      .update(models)
      .set({ status: 'deprecated' })
      .where(
        and(
          inArray(
            models.id,
            vanished.map((m) => m.id),
          ),
          not(eq(models.source, 'custom')),
        ),
      );
    report.deprecated.push(...vanished.map((m) => m.canonicalId));
  }

  return report;
}
