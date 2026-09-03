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
 * Only DigitalOcean today: OpenAI/Groq/etc. are covered by the vendored LiteLLM feed, and the
 * local tiers are pinned to the operator's own server. DO is the kind whose model set changes
 * without any router release.
 */
import type { Logger } from 'pino';
import { and, eq, ne, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { models, type providers } from '../../db/schema.js';
import { getJson } from '../adapters/http.js';
import { writeAudit } from '../protect/audit.js';

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
  // place — idempotent, touches only the two flag columns, never specs/overrides.
  for (const canonicalId of plan.alreadyKnown) {
    const native = canonicalId.slice(DO_NAMESPACE.length + 1);
    const hosting = thirdPartyHostingFor(native);
    if (!hosting) continue;
    thirdPartyHosted.push(canonicalId);
    await db
      .update(models)
      .set({ thirdPartyHosted: true, retentionNote: hosting.retentionNote })
      .where(
        and(
          eq(models.canonicalId, canonicalId),
          or(eq(models.thirdPartyHosted, false), ne(models.retentionNote, hosting.retentionNote)),
        ),
      );
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

/**
 * Nightly: discover across every configured DigitalOcean provider. Best-effort — a provider
 * that errors (endpoint down, missing key) is logged and never blocks the others or the
 * catalog sync. Audits only when something new was actually added (a config-relevant change).
 */
export async function runProviderDiscovery(
  db: Db,
  log: Logger,
  getApiKey: (providerId: string) => Promise<string | undefined>,
): Promise<DiscoverResult[]> {
  const doProviders = await db.query.providers.findMany({
    where: (p, { and, eq, isNull }) => and(eq(p.kind, 'digitalocean'), isNull(p.deletedAt)),
  });
  const results: DiscoverResult[] = [];
  for (const provider of doProviders) {
    try {
      const apiKey = await getApiKey(provider.id);
      const result = await discoverDigitalOceanModels(db, provider, apiKey);
      results.push(result);
      if (result.discovered.length > 0) {
        log.info(
          { provider: provider.label, discovered: result.discovered },
          'discovered new provider models',
        );
        await writeAudit(db, {
          firmId: provider.firmId,
          event: 'provider_models_discovered',
          detail: {
            providerId: provider.id,
            providerLabel: provider.label,
            discovered: result.discovered,
            alreadyKnown: result.alreadyKnown,
          },
        }).catch(() => {});
      }
    } catch (err) {
      log.warn({ err, provider: provider.label }, 'provider model discovery failed');
    }
  }
  return results;
}
