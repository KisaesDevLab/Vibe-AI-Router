/**
 * Provider model auto-discovery (Q-082): query a live provider's OpenAI-compatible `/models`
 * endpoint and add any model it serves that the catalog does not already carry — so operators
 * no longer hand-edit data/digitalocean-models.json and cut a router release every time
 * DigitalOcean adds a Gradient serverless model.
 *
 * ADDITIVE ONLY — never deprecates, deletes, or overwrites an existing row. A live list
 * endpoint can be partial or transiently empty, and the vendored curated feed remains the
 * source of ACCURATE specs. Discovered rows carry source='provider' (distinct from
 * 'synced'/'custom'): the nightly vendored sync leaves them untouched by its vanish-check
 * (which only deprecates 'synced'), yet WILL enrich them in place if a curated
 * data/digitalocean-models.json entry with the same canonical id later ships — so the
 * conservative placeholder specs below are self-healing.
 *
 * DigitalOcean and Anthropic (Q-101): both release models between router releases, and both
 * expose a live list. OpenAI/Groq/etc. stay on the vendored LiteLLM feed, and the local tiers
 * are pinned to the operator's own server. Orchestration across providers, and the pricing
 * that goes with a pull, lives in refresh.ts.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { models, type providers } from '../../db/schema.js';
import { getJson } from '../adapters/http.js';
import { ANTHROPIC_VERSION } from '../adapters/anthropic/translate.js';

type ProviderRow = typeof providers.$inferSelect;

/**
 * Placeholder specs for a freshly discovered model, deliberately conservative (Q-082):
 * - contextWindow: a modest floor so a discovered model is never PREFERRED over a curated
 *   large-context one by the default-pack picker (which tie-breaks on context window); the
 *   curated feed corrects it on adoption.
 * - capabilities: json_schema only (Q-083) — DigitalOcean's inference API is OpenAI-compatible
 *   and JSON/structured output is broadly supported, so discovered models are immediately
 *   selectable for cloud JSON task classes without per-model setup. tools/vision stay off
 *   (more model-specific); an operator enables them via capability overrides after verifying.
 * - pricing: NONE inserted → the ledger flags cost_unknown (never silently zero).
 */
export const DISCOVERED_CONTEXT_WINDOW = 8192;
/** Capabilities every discovered DO model advertises by default (Q-083). */
export const DISCOVERED_CAPABILITIES: Record<string, boolean> = { json_schema: true };
const DO_NAMESPACE = 'digitalocean';

/**
 * Third-party-hosted models on DigitalOcean (Q-098, Vibe 1040 item E2). DO's /models also
 * lists commercial Anthropic and OpenAI models; the curated file deliberately excludes them
 * (Q-061) but discovery re-admitted them as ordinary rows, so an operator could bind a
 * cloud_deidentified class to Claude-on-DO without seeing that the retention terms are the
 * vendor's. Tagged, NOT filtered: a firm may legitimately want Claude on DO for a class whose
 * WISP names Anthropic — the point is that it is a visible, acknowledged choice.
 *
 * `openai-gpt-oss-*` is open-weight and DO-hosted (already curated) — excluded on purpose.
 * Note text quotes docs.digitalocean.com/products/gradient-ai-platform/details/data-privacy
 * as read on 2026-09-03; re-verify when DO's page changes. Keep in sync with migration 0007.
 */
export interface ThirdPartyHosting {
  vendor: 'anthropic' | 'openai';
  retentionNote: string;
}
export const THIRD_PARTY_HOSTED: ReadonlyArray<{ test: RegExp } & ThirdPartyHosting> = [
  {
    test: /^anthropic-/,
    vendor: 'anthropic',
    retentionNote:
      "Hosted by DigitalOcean but served under Anthropic's terms: zero retention, EXCEPT Claude Fable 5.1 / Fable 5, which require a mandatory 30-day retention of prompts and completions for trust-and-safety review (docs.digitalocean.com data-privacy page, 2026-09-03). Confirm against the firm's WISP before binding.",
  },
  {
    test: /^openai-(?!gpt-oss-)/,
    vendor: 'openai',
    retentionNote:
      "Hosted by DigitalOcean but served under OpenAI's terms. DigitalOcean's data-privacy page (2026-09-03) states OpenAI's zero-data-retention policy applies and excludes customer content from abuse-monitoring logs; those are OpenAI's terms, not DigitalOcean's. Confirm against the firm's WISP before binding.",
  },
];

/** Pure: the third-party hosting record for a NATIVE (un-namespaced) DO model id, if any. */
export function thirdPartyHostingFor(nativeId: string): ThirdPartyHosting | undefined {
  const hit = THIRD_PARTY_HOSTED.find((t) => t.test.test(nativeId));
  return hit ? { vendor: hit.vendor, retentionNote: hit.retentionNote } : undefined;
}

export interface DiscoveryPlan {
  toInsert: { canonicalId: string; displayName: string; thirdPartyHosted?: ThirdPartyHosting }[];
  /** known rows that match the third-party predicate — re-tagged idempotently on every run */
  alreadyKnown: string[];
  skipped: string[];
}

/** Pure: given the ids a provider serves + the catalog's current canonical ids, decide what to add. */
export function planDiscovery(
  servedIds: unknown[],
  existingCanonicalIds: ReadonlySet<string>,
  namespace: string = DO_NAMESPACE,
): DiscoveryPlan {
  const plan: DiscoveryPlan = { toInsert: [], alreadyKnown: [], skipped: [] };
  const seen = new Set<string>();
  for (const raw of servedIds) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) {
      plan.skipped.push(String(raw));
      continue;
    }
    // accept both bare ids and already-namespaced ones; normalize to `<namespace>/<native>`
    const native = id.startsWith(`${namespace}/`) ? id.slice(namespace.length + 1) : id;
    if (!native) {
      plan.skipped.push(id);
      continue;
    }
    const canonicalId = `${namespace}/${native}`;
    if (seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    if (existingCanonicalIds.has(canonicalId)) plan.alreadyKnown.push(canonicalId);
    else {
      const thirdPartyHosted = thirdPartyHostingFor(native);
      plan.toInsert.push({
        canonicalId,
        displayName: native,
        ...(thirdPartyHosted ? { thirdPartyHosted } : {}),
      });
    }
  }
  return plan;
}

/** IO: list the model ids a provider's `/models` endpoint reports (OpenAI list shape). */
export async function listServedModelIds(
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body = (await getJson(`${base}/models`, headers, signal)) as { data?: unknown };
  if (!Array.isArray(body.data)) return [];
  return body.data
    .map((m) => (m && typeof m === 'object' && 'id' in m ? (m as { id: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string');
}

export interface DiscoverResult {
  providerId: string;
  providerLabel: string;
  discovered: string[];
  alreadyKnown: number;
  skipped: string[];
  /** canonical ids (new or pre-existing) carrying the third-party-hosted flag after this run */
  thirdPartyHosted: string[];
}

type ListIds = (baseUrl: string, apiKey: string | undefined, signal: AbortSignal) => Promise<string[]>;

/**
 * Discover + insert for one DigitalOcean provider. Insertion is idempotent
 * (onConflictDoNothing on the unique canonical id), so a nightly run racing an on-demand one
 * cannot double-insert. `listIds` is injectable for tests.
 */
export async function discoverDigitalOceanModels(
  db: Db,
  provider: ProviderRow,
  apiKey: string | undefined,
  opts?: { listIds?: ListIds; signal?: AbortSignal },
): Promise<DiscoverResult> {
  const signal = opts?.signal ?? AbortSignal.timeout(20_000);
  const list = opts?.listIds ?? listServedModelIds;
  const served = await list(provider.baseUrl, apiKey, signal);
  const existing = await db.query.models.findMany();
  const plan = planDiscovery(served, new Set(existing.map((m) => m.canonicalId)));

  const discovered: string[] = [];
  const thirdPartyHosted: string[] = [];
  for (const m of plan.toInsert) {
    const [row] = await db
      .insert(models)
      .values({
        canonicalId: m.canonicalId,
        providerKind: 'digitalocean',
        displayName: m.displayName,
        contextWindow: DISCOVERED_CONTEXT_WINDOW,
        maxOutput: null,
        capabilities: DISCOVERED_CAPABILITIES,
        source: 'provider',
        thirdPartyHosted: m.thirdPartyHosted !== undefined,
        retentionNote: m.thirdPartyHosted?.retentionNote ?? null,
      })
      .onConflictDoNothing({ target: models.canonicalId })
      .returning({ id: models.id });
    if (row) discovered.push(m.canonicalId);
    if (m.thirdPartyHosted) thirdPartyHosted.push(m.canonicalId);
  }
  // Rows discovered before 0007 (or whose note text has since been revised) are re-tagged in
  // place — touches only the two flag columns, never specs/overrides. Compared in memory
  // against the rows already loaded above, so steady state issues ZERO writes.
  const existingById = new Map(existing.map((m) => [m.canonicalId, m]));
  for (const canonicalId of plan.alreadyKnown) {
    const native = canonicalId.slice(DO_NAMESPACE.length + 1);
    const hosting = thirdPartyHostingFor(native);
    if (!hosting) continue;
    thirdPartyHosted.push(canonicalId);
    const row = existingById.get(canonicalId);
    if (row && row.thirdPartyHosted && row.retentionNote === hosting.retentionNote) continue;
    await db
      .update(models)
      .set({ thirdPartyHosted: true, retentionNote: hosting.retentionNote })
      .where(eq(models.canonicalId, canonicalId));
  }
  return {
    providerId: provider.id,
    providerLabel: provider.label,
    discovered,
    alreadyKnown: plan.alreadyKnown.length,
    skipped: plan.skipped,
    thirdPartyHosted,
  };
}

// ── Anthropic (Q-101) ────────────────────────────────────────────────────────────────────────

/**
 * One entry of Anthropic's `GET /v1/models`. Unlike DigitalOcean's list, it publishes real
 * specs — `max_input_tokens` (the context window), `max_tokens` (the output cap) and a
 * `capabilities` tree with `supported` at each leaf — so a discovered Claude model needs no
 * placeholder. It publishes no pricing; that comes from the live pricing feed (live-pricing.ts).
 */
const anthropicModelSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.:\-]{1,200}$/),
    display_name: z.string().min(1).max(200).optional(),
    max_input_tokens: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional(),
    capabilities: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type AnthropicModel = z.infer<typeof anthropicModelSchema>;

const ANTHROPIC_NAMESPACE = 'anthropic';
const ANTHROPIC_PAGE_LIMIT = 1000;
const ANTHROPIC_MAX_PAGES = 10;

/**
 * Pure: Models API capability tree → internal capability keys. Tool calling and prompt caching
 * are properties of the Messages API for every Claude model (the vendored feed marks them true
 * across the family), so they are asserted for the kind; the rest is read from the tree and
 * left unset when the leaf is absent.
 */
export function anthropicCapabilities(tree: Record<string, unknown> | undefined): Record<string, boolean> {
  const supported = (key: string): boolean | undefined => {
    const node = tree?.[key];
    if (node === null || typeof node !== 'object') return undefined;
    const value = (node as { supported?: unknown }).supported;
    return typeof value === 'boolean' ? value : undefined;
  };
  const vision = supported('image_input');
  const jsonSchema = supported('structured_outputs');
  const reasoning = supported('thinking');
  return {
    tools: true,
    caching: true,
    ...(vision !== undefined ? { vision } : {}),
    ...(jsonSchema !== undefined ? { json_schema: jsonSchema } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

/** IO: every model the key can use, following `has_more` / `last_id` pagination. */
export async function listAnthropicModels(
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<unknown[]> {
  const base = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    accept: 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (apiKey) headers['x-api-key'] = apiKey;
  const out: unknown[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < ANTHROPIC_MAX_PAGES; page++) {
    const query = `limit=${ANTHROPIC_PAGE_LIMIT}${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`;
    const body = (await getJson(`${base}/v1/models?${query}`, headers, signal)) as {
      data?: unknown;
      has_more?: unknown;
      last_id?: unknown;
    };
    if (!Array.isArray(body.data)) break;
    out.push(...(body.data as unknown[]));
    if (body.has_more !== true || typeof body.last_id !== 'string' || body.last_id === afterId) break;
    afterId = body.last_id;
  }
  return out;
}

type ListAnthropicModels = (
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
) => Promise<unknown[]>;

/**
 * Discover + insert for one Anthropic provider. Same ownership rules as DigitalOcean: unknown
 * ids are inserted as source='provider'; 'synced' and 'custom' rows are never touched; an id
 * the vendored feed carries is left for its sync to create (so it lands as 'synced', with the
 * feed's deprecation tracking). A row this discovery created earlier is refreshed
 * conservatively — capabilities additively, specs only where still placeholder/unset — so an
 * operator's corrections survive. No pricing is written here.
 */
export async function discoverAnthropicModels(
  db: Db,
  provider: ProviderRow,
  apiKey: string | undefined,
  opts?: { listModels?: ListAnthropicModels; signal?: AbortSignal; curatedIds?: ReadonlySet<string> },
): Promise<DiscoverResult> {
  const signal = opts?.signal ?? AbortSignal.timeout(20_000);
  const served = await (opts?.listModels ?? listAnthropicModels)(provider.baseUrl, apiKey, signal);
  const existing = new Map((await db.query.models.findMany()).map((m) => [m.canonicalId, m]));

  const discovered: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let alreadyKnown = 0;
  for (const raw of served) {
    const parsed = anthropicModelSchema.safeParse(raw);
    if (!parsed.success) {
      // never echo an id that failed validation — it is untrusted provider output and this
      // list reaches the admin API response
      skipped.push('malformed entry');
      continue;
    }
    const m = parsed.data;
    const canonicalId = `${ANTHROPIC_NAMESPACE}/${m.id}`;
    if (seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    const capabilities = anthropicCapabilities(m.capabilities);
    const row = existing.get(canonicalId);

    if (!row) {
      if (opts?.curatedIds?.has(canonicalId)) {
        alreadyKnown++;
        continue;
      }
      const [inserted] = await db
        .insert(models)
        .values({
          canonicalId,
          providerKind: 'anthropic',
          displayName: m.display_name ?? m.id,
          contextWindow: m.max_input_tokens ?? DISCOVERED_CONTEXT_WINDOW,
          maxOutput: m.max_tokens ?? null,
          capabilities,
          source: 'provider',
        })
        .onConflictDoNothing({ target: models.canonicalId })
        .returning({ id: models.id });
      if (inserted) discovered.push(canonicalId);
      continue;
    }

    alreadyKnown++;
    if (row.source !== 'provider' || opts?.curatedIds?.has(canonicalId)) continue;
    const set: Partial<typeof models.$inferInsert> = {};
    const base = { ...((row.capabilities ?? {}) as Record<string, boolean>) };
    let capsChanged = false;
    for (const [key, val] of Object.entries(capabilities)) {
      if (val && base[key] !== true) {
        base[key] = true;
        capsChanged = true;
      }
    }
    if (capsChanged) set.capabilities = base;
    if (m.max_input_tokens !== undefined && row.contextWindow === DISCOVERED_CONTEXT_WINDOW) {
      set.contextWindow = m.max_input_tokens;
    }
    if (m.max_tokens !== undefined && row.maxOutput === null) set.maxOutput = m.max_tokens;
    if (Object.keys(set).length > 0) await db.update(models).set(set).where(eq(models.id, row.id));
  }
  return {
    providerId: provider.id,
    providerLabel: provider.label,
    discovered,
    alreadyKnown,
    skipped,
    thirdPartyHosted: [],
  };
}

/** Provider kinds whose served-model list can be pulled live. */
export const DISCOVERABLE_KINDS = ['digitalocean', 'anthropic'] as const;
export type DiscoverableKind = (typeof DISCOVERABLE_KINDS)[number];

export function isDiscoverableKind(kind: string): kind is DiscoverableKind {
  return (DISCOVERABLE_KINDS as readonly string[]).includes(kind);
}

/** Dispatch by provider kind. Throws for a kind with no live model list. */
export async function discoverProviderModels(
  db: Db,
  provider: ProviderRow,
  apiKey: string | undefined,
  opts?: {
    listIds?: ListIds;
    listAnthropicModels?: ListAnthropicModels;
    signal?: AbortSignal;
    curatedIds?: ReadonlySet<string>;
  },
): Promise<DiscoverResult> {
  if (provider.kind === 'digitalocean') {
    return discoverDigitalOceanModels(db, provider, apiKey, {
      ...(opts?.listIds ? { listIds: opts.listIds } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }
  if (provider.kind === 'anthropic') {
    return discoverAnthropicModels(db, provider, apiKey, {
      ...(opts?.listAnthropicModels ? { listModels: opts.listAnthropicModels } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.curatedIds ? { curatedIds: opts.curatedIds } : {}),
    });
  }
  throw new Error(`model discovery is not supported for provider kind ${provider.kind}`);
}
