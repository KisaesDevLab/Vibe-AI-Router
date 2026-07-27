/**
 * Request pipeline (2.6) — explicit ordered stages:
 *   auth → resolveTaskClass → policy → scrub → route → adapt → ledger → respond
 * Each stage is a pure(ish) function over (ctx, deps) so it is unit-testable in isolation.
 * Failures throw RouterError; the runner guarantees the ledger stage still runs (one row per
 * request, Phase 9 makes it real).
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { appTokens, models, policies, providers, taskClasses } from '../../db/schema.js';
import type { AIRequest, AIResponse, StreamChunk } from './envelope.js';
import { requestHash } from './envelope.js';
import { RouterError, toRouterError } from './errors.js';
import type { ExecuteContext, GatewayAdapter } from './adapter-types.js';

// row types inferred from schema
type TaskClassRow = typeof taskClasses.$inferSelect;
type PolicyRow = typeof policies.$inferSelect;
type ProviderRow = typeof providers.$inferSelect;
type ModelRow = typeof models.$inferSelect;

export interface AuthContext {
  firmId: string;
  app: string;
  scopes: string[];
  tokenId: string;
}

export interface RouteDecision {
  provider: ProviderRow;
  model: ModelRow;
  adapter: GatewayAdapter;
  executeCtx: ExecuteContext;
}

export interface PipelineCtx {
  requestId: string;
  requestHash: string;
  startedAt: number;
  auth?: AuthContext;
  taskClass?: TaskClassRow;
  policy?: PolicyRow;
  envelope: AIRequest;
  route?: RouteDecision;
  response?: AIResponse;
  stream?: AsyncIterable<StreamChunk>;
  error?: RouterError;
}

export interface AdapterRegistry {
  forKind(kind: ProviderRow['kind']): GatewayAdapter | undefined;
}

export interface LedgerWriter {
  write(ctx: PipelineCtx): Promise<void>;
}

/** Phase 2 stub — Phase 9 replaces with the real ledger. Interface is the contract. */
export class NoopLedger implements LedgerWriter {
  write(): Promise<void> {
    return Promise.resolve();
  }
}

export interface PipelineDeps {
  db: Db;
  adapters: AdapterRegistry;
  ledger: LedgerWriter;
  log: Logger;
  /** decrypted API key lookup (Phase 6 vault); absent → keyless providers only */
  getApiKey?: (providerId: string) => Promise<string | undefined>;
  /** passive provider health recording (Phase 6); absent → no-op */
  recordHealth?: (providerId: string, firmId: string, providerLabel: string, ok: boolean) => void;
}

export function newPipelineCtx(envelope: AIRequest): PipelineCtx {
  return {
    requestId: randomUUID(),
    requestHash: requestHash(envelope.messages),
    startedAt: Date.now(),
    envelope,
  };
}

// ── stage: auth (2.5) ────────────────────────────────────────────────────────

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function stageAuth(
  ctx: PipelineCtx,
  deps: PipelineDeps,
  bearerToken: string | undefined,
): Promise<void> {
  if (!bearerToken) throw new RouterError('auth_error', 'missing bearer token');
  const presented = hashToken(bearerToken);
  const row = await deps.db.query.appTokens.findFirst({
    where: and(eq(appTokens.tokenHash, presented), isNull(appTokens.revokedAt)),
  });
  // constant-time compare of the presented hash against the stored hash (2.5); the DB lookup
  // is by exact hash so a miss reveals nothing beyond non-existence.
  if (!row || !timingSafeEqual(Buffer.from(presented, 'hex'), Buffer.from(row.tokenHash, 'hex'))) {
    throw new RouterError('auth_error', 'invalid app token');
  }
  if (!row.scopes.includes('chat')) {
    throw new RouterError('auth_error', 'token lacks required scope: chat');
  }
  ctx.auth = { firmId: row.firmId, app: row.app, scopes: row.scopes, tokenId: row.id };
  ctx.envelope.metadata.app = row.app;
  // fire-and-forget freshness marker; failure here must never fail the request
  void deps.db
    .update(appTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(appTokens.id, row.id))
    .catch(() => {});
}

// ── stage: resolve task class (fail closed on unknown — principle 3) ────────

export async function stageResolveTaskClass(ctx: PipelineCtx, deps: PipelineDeps): Promise<void> {
  const key = ctx.envelope.taskClass;
  if (!key) throw new RouterError('policy_blocked', 'missing X-Vibe-Task-Class header');
  const row = await deps.db.query.taskClasses.findFirst({ where: eq(taskClasses.key, key) });
  if (!row) throw new RouterError('policy_blocked', `unknown task class: ${key}`);
  ctx.taskClass = row;
}

// ── stage: policy (Phase 2 minimal — Phase 7 expands to the full engine) ────

export async function stagePolicy(ctx: PipelineCtx, deps: PipelineDeps): Promise<void> {
  const auth = ctx.auth;
  const tc = ctx.taskClass;
  if (!auth || !tc) throw new RouterError('unknown', 'pipeline ordering violation');
  const row = await deps.db.query.policies.findFirst({
    where: and(eq(policies.firmId, auth.firmId), eq(policies.taskClassId, tc.id)),
  });
  if (!row || !row.enabled) {
    throw new RouterError('policy_blocked', `no enabled policy for task class ${tc.key}`);
  }
  ctx.policy = row;
  // max_tokens injection baseline (7.8 refines with clamping)
  if (ctx.envelope.maxTokens === undefined) {
    ctx.envelope.maxTokens = row.maxTokensOverride ?? tc.defaultMaxTokens;
  }
}

// ── stage: scrub (Phase 2 pass-through — Phase 8 implements) ─────────────────

export function stageScrub(_ctx: PipelineCtx, _deps: PipelineDeps): Promise<void> {
  return Promise.resolve();
}

// ── stage: route ─────────────────────────────────────────────────────────────

export async function stageRoute(ctx: PipelineCtx, deps: PipelineDeps): Promise<void> {
  const auth = ctx.auth;
  const policy = ctx.policy;
  const tc = ctx.taskClass;
  if (!auth || !policy || !tc) throw new RouterError('unknown', 'pipeline ordering violation');

  const model = await deps.db.query.models.findFirst({ where: eq(models.id, policy.defaultModelId) });
  if (!model) throw new RouterError('policy_blocked', 'policy default model not found in catalog');

  // sensitivity enforcement, request-time (defense in depth; full engine in Phase 7)
  if (tc.sensitivity === 'local_only' && model.providerKind !== 'local') {
    throw new RouterError('policy_blocked', 'local_only task class cannot route to a cloud model');
  }

  const provider = await deps.db.query.providers.findFirst({
    where: and(
      eq(providers.firmId, auth.firmId),
      eq(providers.kind, model.providerKind),
      isNull(providers.deletedAt),
    ),
  });
  if (!provider) {
    throw new RouterError('provider_unavailable', `no ${model.providerKind} provider configured`);
  }

  const adapter = deps.adapters.forKind(provider.kind);
  if (!adapter) throw new RouterError('provider_unavailable', `no adapter for kind ${provider.kind}`);

  // credential resolution (Phase 6): providers that need a key must have a decryptable one
  let apiKey: string | undefined;
  if (provider.authType === 'api_key') {
    apiKey = deps.getApiKey ? await deps.getApiKey(provider.id) : undefined;
    if (!apiKey) {
      throw new RouterError('provider_unavailable', `no active credential for provider ${provider.label}`);
    }
  }

  const executeCtx: ExecuteContext = {
    providerId: provider.id,
    model: model.canonicalId,
    baseUrl: provider.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(provider.modelMapping && typeof provider.modelMapping === 'object'
      ? { modelMapping: provider.modelMapping as Record<string, string> }
      : {}),
  };
  ctx.route = { provider, model, adapter, executeCtx };
}

// ── stage: adapt ─────────────────────────────────────────────────────────────

export async function stageAdapt(ctx: PipelineCtx, deps: PipelineDeps, signal: AbortSignal): Promise<void> {
  const route = ctx.route;
  const auth = ctx.auth;
  if (!route || !auth) throw new RouterError('unknown', 'pipeline ordering violation');
  const record = (ok: boolean): void =>
    deps.recordHealth?.(route.provider.id, auth.firmId, route.provider.label, ok);
  if (ctx.envelope.stream) {
    ctx.stream = route.adapter.executeStream(ctx.envelope, route.executeCtx, signal);
    // stream outcome is recorded by the SSE relay when the stream ends
  } else {
    try {
      ctx.response = await route.adapter.execute(ctx.envelope, route.executeCtx, signal);
      record(true);
    } catch (err) {
      record(false);
      throw err;
    }
  }
}

// ── runner ───────────────────────────────────────────────────────────────────

/**
 * Runs auth → … → adapt. On ANY failure, records the RouterError on ctx and rethrows after
 * the ledger write. For streaming, the ledger stage runs from the route layer once the stream
 * finishes (usage arrives in the final chunk).
 */
export async function runPipeline(
  ctx: PipelineCtx,
  deps: PipelineDeps,
  bearerToken: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  try {
    await stageAuth(ctx, deps, bearerToken);
    await stageResolveTaskClass(ctx, deps);
    await stagePolicy(ctx, deps);
    await stageScrub(ctx, deps);
    await stageRoute(ctx, deps);
    await stageAdapt(ctx, deps, signal);
    if (!ctx.envelope.stream) await deps.ledger.write(ctx);
  } catch (err) {
    ctx.error = toRouterError(err);
    try {
      await deps.ledger.write(ctx);
    } catch (ledgerErr) {
      deps.log.error({ err: ledgerErr, requestId: ctx.requestId }, 'ledger write failed');
    }
    throw ctx.error;
  }
}
