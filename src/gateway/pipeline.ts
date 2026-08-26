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
import { appTokens, isLocalKind, models, providers, taskClasses } from '../../db/schema.js';
import type { AIRequest, AIResponse, StreamChunk } from './envelope.js';
import { requestHash } from './envelope.js';
import { RETRYABLE_CODES, RouterError, toRouterError } from './errors.js';
import type { ExecuteContext, GatewayAdapter } from './adapter-types.js';
import {
  applyLimits,
  checkRole,
  classRequires,
  modelViolation,
  selectModel,
  type EffectivePolicy,
  type PolicyEngine,
} from '../policy/engine.js';
import { redactEnvelope, scanEnvelope, type MatchType, type ScrubReport } from '../protect/scrub.js';
import type { AuditEntry } from '../protect/audit.js';
import { checkBudgets, currentPeriod, type BudgetSettings } from '../ledger/budget.js';
import { checkBaseUrl } from '../lib/ssrf.js';

// row types inferred from schema
type TaskClassRow = typeof taskClasses.$inferSelect;
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
  effective?: EffectivePolicy;
  envelope: AIRequest;
  route?: RouteDecision;
  response?: AIResponse;
  stream?: AsyncIterable<StreamChunk>;
  error?: RouterError;
  /** set when the scrubber matched (redact/warn modes) — counts only, never values */
  scrubbed?: { mode: 'redact' | 'warn' | 'block'; counts: Partial<Record<MatchType, number>> };
  /**
   * Redacted outbound copy for CLOUD hops when the primary model is local (Q-072): fallback
   * can reach cloud even though the primary-serving path never leaves the box, so the scrub
   * product is held here and swapped in per hop by the resilience executor.
   */
  cloudEnvelope?: AIRequest;
  /** block mode + local primary: matches found — cloud hops are barred, local still serves */
  cloudBlockedCounts?: Record<string, number>;
  /** internal: blocked_scrubber audit emitted once for barred cloud hops */
  cloudBlockAudited?: boolean;
  /** soft budget warnings for the response header (9.4) */
  budgetWarnings?: string[];
  /** served from the response cache (13.2) */
  cacheHit?: boolean;
  /**
   * The PRIMARY model could not be routed (provider row gone, credential revoked, base_url
   * rejected). Not fatal on its own: the resilience executor re-routes every hop, so the
   * fallback chain gets its chance and this is only surfaced if the whole chain is unusable.
   */
  routeError?: RouterError;
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
  /** policy engine (Phase 7) — resolution cache + validation */
  engine: PolicyEngine;
  /** decrypted API key lookup (Phase 6 vault); absent → keyless providers only */
  getApiKey?: (providerId: string) => Promise<string | undefined>;
  /** passive provider health recording (Phase 6); absent → no-op */
  recordHealth?: (providerId: string, firmId: string, providerLabel: string, ok: boolean) => void;
  /** fire-and-forget audit emission (Phase 8); implementations must swallow their own errors */
  audit?: (entry: AuditEntry) => void;
  /** resilience layer (Phase 10): retries/breaker/fallbacks/timeouts/shed */
  resilience?: import('../resilience/executor.js').ResilienceConfig;
  /** rate limiters (Phase 10) — keyed per app token and per user */
  rateLimits?: { perToken: import('../resilience/limiter.js').RateLimiter; perUser: import('../resilience/limiter.js').RateLimiter };
  /** Prometheus metrics (13.1) */
  metrics?: import('../ops/metrics.js').Metrics;
  /** opt-in response cache (13.2) */
  responseCache?: import('../ops/cache.js').ResponseCache;
  /** SSRF request-time toggle (14.2): deny cloud providers on private hosts. Default TRUE. */
  ssrfDenyPrivateCloud?: boolean;
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

/** Reusable app-token authentication (2.5) — also used by the registration endpoint (7.1). */
export async function authenticateAppToken(db: Db, bearerToken: string | undefined): Promise<AuthContext> {
  if (!bearerToken) throw new RouterError('auth_error', 'missing bearer token');
  const presented = hashToken(bearerToken);
  const row = await db.query.appTokens.findFirst({
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
  // fire-and-forget freshness marker; failure here must never fail the request
  void db
    .update(appTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(appTokens.id, row.id))
    .catch(() => {});
  return { firmId: row.firmId, app: row.app, scopes: row.scopes, tokenId: row.id };
}

export async function stageAuth(
  ctx: PipelineCtx,
  deps: PipelineDeps,
  bearerToken: string | undefined,
): Promise<void> {
  ctx.auth = await authenticateAppToken(deps.db, bearerToken);
  ctx.envelope.metadata.app = ctx.auth.app;

  // rate limiting (10.6): per app-token, then per user when user context is present
  if (deps.rateLimits) {
    const tokenWait = deps.rateLimits.perToken.take(`t:${ctx.auth.tokenId}`);
    const userWait = ctx.envelope.metadata.userId
      ? deps.rateLimits.perUser.take(`u:${ctx.auth.firmId}:${ctx.envelope.metadata.userId}`)
      : undefined;
    const wait = Math.max(tokenWait ?? 0, userWait ?? 0);
    if (wait > 0) {
      deps.audit?.({
        firmId: ctx.auth.firmId,
        event: 'rate_limited',
        app: ctx.auth.app,
        detail: { key: tokenWait ? 'app_token' : 'user', retryAfterSeconds: wait },
      });
      throw new RouterError('rate_limited', 'rate limit exceeded', { retryAfterSeconds: wait });
    }
  }
}

// ── stage: resolve task class (fail closed on unknown — principle 3) ────────

export function stageResolveTaskClass(ctx: PipelineCtx, _deps: PipelineDeps): Promise<void> {
  // presence check only — the row itself comes from the (cached) engine resolve in stagePolicy;
  // an unknown key fails closed there with the same policy_blocked code (hot-path: one less query)
  if (!ctx.envelope.taskClass) {
    throw new RouterError('policy_blocked', 'missing X-Vibe-Task-Class header');
  }
  return Promise.resolve();
}

// ── stage: policy (Phase 7 engine: resolution + role gating + limit clamps) ─

export async function stagePolicy(ctx: PipelineCtx, deps: PipelineDeps): Promise<void> {
  const auth = ctx.auth;
  if (!auth) throw new RouterError('unknown', 'pipeline ordering violation');
  const firmSettings = await deps.engine.firmSettings(auth.firmId); // cached, 10s TTL
  const effective = await deps.engine.resolve(auth.firmId, ctx.envelope.taskClass, firmSettings);
  ctx.taskClass = effective.taskClass;
  checkRole(effective, ctx.envelope.metadata.userRole); // 7.7
  applyLimits(effective, ctx.envelope); // 7.6 temperature clamps + 7.8 max_tokens
  ctx.effective = effective;
}

// ── stage: budget fast-path (9.4/9.5) ────────────────────────────────────────

export async function stageBudget(ctx: PipelineCtx, deps: PipelineDeps): Promise<void> {
  const auth = ctx.auth;
  const effective = ctx.effective;
  if (!auth || !effective) throw new RouterError('unknown', 'pipeline ordering violation');
  const settings = (effective.firmSettings as { budgets?: BudgetSettings }).budgets ?? {};
  const result = await checkBudgets(deps.db, {
    firmId: auth.firmId,
    app: auth.app,
    ...(ctx.envelope.metadata.userId ? { userId: ctx.envelope.metadata.userId } : {}),
    taskClassId: effective.taskClass.id,
    settings,
    policyMonthlyCents: effective.policy.monthlyBudgetCents,
  });
  if (result.softWarnings.length > 0) {
    ctx.budgetWarnings = result.softWarnings.map(
      (w) => `${w.scope}:${Math.round((w.spentCents / w.limitCents) * 100)}%`,
    );
    for (const w of result.softWarnings) {
      deps.audit?.({
        firmId: auth.firmId,
        event: 'budget_soft_warning',
        app: auth.app,
        taskClass: effective.taskClass.key,
        detail: {
          scope: w.scope,
          scopeRef: w.scopeRef,
          period: currentPeriod(),
          spentCents: w.spentCents,
          limitCents: w.limitCents,
        },
      });
    }
  }
}

// ── stage: scrub (8.2/8.3/8.4) ───────────────────────────────────────────────

/**
 * Runs ONLY when the request is cloud-bound (selected model kind ≠ local). Firm mode:
 * block (default) | redact | warn. Any scrubber ERROR blocks cloud egress — fail closed
 * (principle 3). Blocking reveals match types + counts, never values.
 */
export async function stageScrub(ctx: PipelineCtx, deps: PipelineDeps): Promise<void> {
  const effective = ctx.effective;
  const auth = ctx.auth;
  if (!effective || !auth) throw new RouterError('unknown', 'pipeline ordering violation');

  let cloudPrimary: boolean;
  let report: ScrubReport | undefined;
  const mode = effective.firmSettings.scrubber_mode ?? 'redact';
  try {
    const model = selectModel(effective, ctx.envelope); // same pure selection route uses
    cloudPrimary = !isLocalKind(model.providerKind);
    // fallback hops can reach cloud even when the primary is local (Q-072) — the scrub
    // decision must consider the whole candidate chain, never just the primary
    const cloudInChain = effective.policy.fallbackChain.some((id) => {
      const m = effective.modelsById.get(id);
      return m !== undefined && !isLocalKind(m.providerKind);
    });
    if (!cloudPrimary && !cloudInChain) return;

    if (mode === 'redact') {
      const result = redactEnvelope(ctx.envelope);
      report = result.report;
      if (report.total > 0) {
        if (cloudPrimary) {
          // outbound copy only (8.4): original object untouched; downstream sends the copy
          ctx.envelope = result.envelope;
        } else {
          // local primary serves the ORIGINAL; only cloud hops get the redacted copy
          ctx.cloudEnvelope = result.envelope;
        }
        ctx.scrubbed = { mode, counts: report.counts };
      }
    } else {
      report = scanEnvelope(ctx.envelope);
      if (report.total > 0) ctx.scrubbed = { mode, counts: report.counts };
    }
  } catch (err) {
    if (err instanceof RouterError) throw err; // selection failures keep their own code
    // scrubber failure must never fall through to "allow" (principle 3)
    throw new RouterError('scrubber_blocked', 'scrubber error — cloud egress blocked', {
      detail: { reason: 'scrubber_failure' },
    });
  }

  if (!report || report.total === 0) return;
  const counts = Object.fromEntries(
    Object.entries(report.counts).map(([k, v]) => [k, v ?? 0]),
  ) as Record<string, number>;

  if (mode === 'block') {
    if (!cloudPrimary) {
      // request may still serve locally — cloud hops are barred (enforced in routeForModel)
      ctx.cloudBlockedCounts = counts;
      return;
    }
    deps.audit?.({
      firmId: auth.firmId,
      event: 'blocked_scrubber',
      app: auth.app,
      taskClass: effective.taskClass.key,
      requestHash: ctx.requestHash,
      detail: { mode: 'block', matches: counts },
    });
    throw new RouterError('scrubber_blocked', 'request contains protected data', {
      detail: { matches: counts }, // types + counts only (8.3)
    });
  }
  deps.audit?.({
    firmId: auth.firmId,
    event: mode === 'redact' ? 'scrubber_redacted' : 'scrubber_warning',
    app: auth.app,
    taskClass: effective.taskClass.key,
    requestHash: ctx.requestHash,
    detail: { matches: counts, ...(cloudPrimary ? {} : { scope: 'fallback_only' }) },
  });
  await Promise.resolve();
}

// ── stage: route ─────────────────────────────────────────────────────────────

/**
 * Builds the RouteDecision for one MODEL candidate — request-time enforcement runs first
 * (7.4/7.5/7.6, defense in depth). Fallback logic (Phase 10) re-invokes this per hop, so a
 * fallback can never dodge a check the primary was subject to.
 */
export async function routeForModel(
  model: ModelRow,
  ctx: PipelineCtx,
  deps: PipelineDeps,
): Promise<RouteDecision> {
  const auth = ctx.auth;
  const effective = ctx.effective;
  if (!auth || !effective) throw new RouterError('unknown', 'pipeline ordering violation');

  const violation = modelViolation(model, effective, ctx.envelope);
  if (violation) throw new RouterError(violation.code, violation.reason);

  // block-mode scrub verdict with a local primary (Q-072): cloud hops are barred outright
  if (!isLocalKind(model.providerKind) && ctx.cloudBlockedCounts) {
    if (!ctx.cloudBlockAudited) {
      ctx.cloudBlockAudited = true;
      deps.audit?.({
        firmId: auth.firmId,
        event: 'blocked_scrubber',
        app: auth.app,
        taskClass: effective.taskClass.key,
        requestHash: ctx.requestHash,
        detail: { mode: 'block', matches: ctx.cloudBlockedCounts },
      });
    }
    throw new RouterError('scrubber_blocked', 'request contains protected data — cloud fallback barred', {
      detail: { matches: ctx.cloudBlockedCounts },
    });
  }

  const provider = await deps.engine.providerFor(auth.firmId, model.providerKind); // cached, 10s TTL
  if (!provider) {
    throw new RouterError('provider_unavailable', `no ${model.providerKind} provider configured`);
  }
  if (effective.firmSettings.banned_provider_kinds?.includes(provider.kind)) {
    throw new RouterError('policy_blocked', `provider kind ${provider.kind} is banned by firm policy`);
  }

  // SSRF re-check at request time (14.2) — config-time validation is the deep gate; this
  // pattern check catches rows written around the admin API. Toggle default ON.
  if (deps.ssrfDenyPrivateCloud !== false) {
    const verdict = checkBaseUrl(provider.kind, provider.baseUrl);
    if (!verdict.ok) {
      throw new RouterError('policy_blocked', `provider base_url rejected: ${verdict.reason}`);
    }
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

  const req = classRequires(effective.taskClass);
  const executeCtx: ExecuteContext = {
    providerId: provider.id,
    model: model.canonicalId,
    baseUrl: provider.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(provider.modelMapping && typeof provider.modelMapping === 'object'
      ? { modelMapping: provider.modelMapping as Record<string, string> }
      : {}),
    ...(req.caching ? { promptCaching: true } : {}),
    ...(req.thinking_budget ? { thinkingBudget: req.thinking_budget } : {}),
  };
  return { provider, model, adapter, executeCtx };
}

export async function stageRoute(ctx: PipelineCtx, deps: PipelineDeps): Promise<void> {
  const effective = ctx.effective;
  const auth = ctx.auth;
  if (!effective || !auth) throw new RouterError('unknown', 'pipeline ordering violation');
  // advisory model honored only if allowed+valid; a capability upgrade of a
  // failing default is audited here — the one stage every request passes
  // through — so substitutions are never silent (Q-092 review finding).
  const model = selectModel(effective, ctx.envelope, (up) => {
    deps.metrics?.capabilityUpgradesTotal.inc();
    deps.audit?.({
      firmId: auth.firmId,
      event: 'capability_upgrade',
      app: auth.app,
      taskClass: effective.taskClass.key,
      requestHash: ctx.requestHash,
      detail: { from: up.from, to: up.to, missing: up.missing.join(',').slice(0, 100) },
    });
  });
  try {
    ctx.route = await routeForModel(model, ctx, deps);
  } catch (err) {
    const rerr = toRouterError(err);
    // Routing the primary can fail for reasons a FALLBACK hop routes around cleanly — a deleted
    // provider row, a revoked credential, a base_url the SSRF gate now rejects. Failing here
    // returned that error to the app with the configured chain untouched and zero upstream
    // attempts. The resilient executor re-runs routeForModel per hop and ranks the outcomes
    // with preferError, so hand it the decision. Without a resilience layer (unit-test wiring)
    // there is no chain to defer to, so the error stays fatal.
    if (!deps.resilience) throw rerr;
    ctx.routeError = rerr;
  }
}

// ── stage: adapt ─────────────────────────────────────────────────────────────

export async function stageAdapt(ctx: PipelineCtx, deps: PipelineDeps, signal: AbortSignal): Promise<void> {
  const route = ctx.route;
  const auth = ctx.auth;
  if (!auth) throw new RouterError('unknown', 'pipeline ordering violation');
  // route may be unset when the PRIMARY failed to route (stageRoute deferred to the chain).
  // With no resilience layer there is no chain, so that deferral is fatal here.
  if (!route && !deps.resilience) {
    throw ctx.routeError ?? new RouterError('unknown', 'pipeline ordering violation');
  }

  // response cache (13.2): non-streaming, opt-in per task class, local tier unless cache_cloud
  const req = ctx.effective ? classRequires(ctx.effective.taskClass) : {};
  const cacheTtl = req.cache_ttl_s ?? 0;
  const cacheEligible = !ctx.envelope.stream && deps.responseCache !== undefined && cacheTtl > 0;
  /** Key depends on the model that actually serves, so it is computed per RouteDecision. */
  const keyFor = async (r: RouteDecision): Promise<string | undefined> => {
    if (!cacheEligible) return undefined;
    if (!isLocalKind(r.model.providerKind) && req.cache_cloud !== true) return undefined;
    return (await import('../ops/cache.js')).ResponseCache.key(
      auth.firmId,
      r.model.canonicalId,
      ctx.requestHash,
      // request-shaping params must be part of the key (Q-073) — same messages with a
      // different response_format/tools/temperature are NOT the same response
      createHash('sha256')
        .update(
          JSON.stringify([
            ctx.envelope.tools ?? null,
            ctx.envelope.toolChoice ?? null,
            ctx.envelope.responseFormat ?? null,
            ctx.envelope.maxTokens ?? null,
            ctx.envelope.temperature ?? null,
            ctx.envelope.topP ?? null,
            ctx.envelope.stop ?? null,
          ]),
        )
        .digest('hex')
        .slice(0, 16),
    );
  };
  const cacheKey = route ? await keyFor(route) : undefined;
  const cacheable = cacheKey !== undefined;
  if (cacheable && cacheKey) {
    const hit = deps.responseCache!.get(cacheKey);
    if (hit) {
      ctx.response = { ...hit, served: { ...hit.served, latencyMs: Date.now() - ctx.startedAt } };
      ctx.cacheHit = true;
      deps.metrics?.cacheEvents.inc({ outcome: 'hit' });
      return;
    }
    deps.metrics?.cacheEvents.inc({ outcome: 'miss' });
  }

  if (deps.resilience) {
    // resilient path (Phase 10): retries, breaker, fallback chain, timeouts, shed
    const { executeResilient, executeResilientStream } = await import('../resilience/executor.js');
    if (ctx.envelope.stream) {
      // PRIME the generator: pre-first-chunk failures must surface as HTTP errors (before
      // headers), not as mid-stream error events. Fallback hops happen inside this await.
      const gen = executeResilientStream(ctx, deps, deps.resilience, signal);
      const first = await gen.next();
      ctx.stream = (async function* (): AsyncGenerator<StreamChunk> {
        try {
          if (!first.done) yield first.value;
          yield* gen;
        } finally {
          // consumer may bail (client abort) while gen is still suspended at its first yield —
          // without this, the hop's shed slot + idle timer leak (QA-B finding #3)
          await gen.return(undefined);
        }
      })();
    } else {
      ctx.response = await executeResilient(ctx, deps, deps.resilience, signal);
      // the SERVING hop may differ from the primary (fallback, or a primary that never
      // routed), so re-derive the key from the route that actually answered
      const servedKey = cacheKey ?? (ctx.route ? await keyFor(ctx.route) : undefined);
      if (servedKey && ctx.response) {
        deps.responseCache!.set(servedKey, ctx.response, cacheTtl);
      }
    }
    return;
  }

  if (!route) throw ctx.routeError ?? new RouterError('unknown', 'pipeline ordering violation');

  const record = (ok: boolean): void =>
    deps.recordHealth?.(route.provider.id, auth.firmId, route.provider.label, ok);
  if (ctx.envelope.stream) {
    ctx.stream = route.adapter.executeStream(ctx.envelope, route.executeCtx, signal);
    // stream outcome is recorded by the SSE relay when the stream ends
  } else {
    try {
      ctx.response = await route.adapter.execute(ctx.envelope, route.executeCtx, signal);
      record(true);
      if (cacheable && cacheKey && ctx.response) {
        deps.responseCache!.set(cacheKey, ctx.response, cacheTtl);
      }
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
/** Terminal audit emission (8.5) + metrics (13.1) — once per finished request. */
export function emitTerminalAudit(ctx: PipelineCtx, deps: PipelineDeps): void {
  // metrics fire even without audit wiring
  if (deps.metrics) {
    const taskClass = ctx.taskClass?.key ?? '(none)';
    const provider = ctx.route?.provider.label ?? '(none)';
    const status = ctx.error?.code ?? 'ok';
    deps.metrics.requestsTotal.inc({ task_class: taskClass, provider, status });
    if (!ctx.error) {
      deps.metrics.requestDuration.observe(
        { task_class: taskClass, provider },
        (Date.now() - ctx.startedAt) / 1000,
      );
    }
    if (ctx.error?.code === 'scrubber_blocked') deps.metrics.scrubberBlocksTotal.inc({ task_class: taskClass });
    if (ctx.error?.code === 'budget_exceeded') {
      const scope = ctx.error.detail?.['scope'];
      deps.metrics.budgetRejectionsTotal.inc({ scope: typeof scope === 'string' ? scope : 'unknown' });
    }
    if (ctx.error?.code === 'rate_limited' && !ctx.route) deps.metrics.rateLimitedTotal.inc();
  }

  const auth = ctx.auth;
  if (!auth || !deps.audit) return; // pre-auth failures have no firm to attribute to
  const base = {
    firmId: auth.firmId,
    app: auth.app,
    ...(ctx.taskClass ? { taskClass: ctx.taskClass.key } : {}),
    ...(ctx.route ? { model: ctx.route.model.canonicalId, provider: ctx.route.provider.label } : {}),
    requestHash: ctx.requestHash,
  };
  if (!ctx.error) {
    deps.audit({
      ...base,
      event: 'request',
      detail: {
        status: 'ok',
        stream: ctx.envelope.stream,
        ...(ctx.envelope.modelRequested ? { modelRequested: ctx.envelope.modelRequested } : {}),
        ...(ctx.response ? { modelServed: ctx.response.served.model, latencyMs: ctx.response.served.latencyMs } : {}),
      },
    });
    return;
  }
  if (ctx.error.code === 'scrubber_blocked') return; // already emitted by stageScrub
  if (
    ctx.error.code === 'policy_blocked' ||
    ctx.error.code === 'capability_missing' ||
    ctx.error.code === 'no_vision_provider'
  ) {
    deps.audit({
      ...base,
      event: 'blocked_policy',
      detail: { code: ctx.error.code, reason: ctx.error.message.slice(0, 300) },
    });
    return;
  }
  if (RETRYABLE_CODES.has(ctx.error.code) || ctx.error.code === 'context_exceeded') {
    const providerStatus = ctx.error.detail?.['providerStatus'];
    deps.audit({
      ...base,
      event: 'provider_error',
      detail: {
        code: ctx.error.code,
        ...(typeof providerStatus === 'number' ? { providerStatus } : {}),
        retryable: RETRYABLE_CODES.has(ctx.error.code),
      },
    });
  }
}

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
    await stageBudget(ctx, deps);
    await stageScrub(ctx, deps);
    await stageRoute(ctx, deps);
    await stageAdapt(ctx, deps, signal);
    if (!ctx.envelope.stream) {
      await deps.ledger.write(ctx);
      emitTerminalAudit(ctx, deps);
    }
  } catch (err) {
    ctx.error = toRouterError(err);
    try {
      await deps.ledger.write(ctx);
    } catch (ledgerErr) {
      deps.log.error({ err: ledgerErr, requestId: ctx.requestId }, 'ledger write failed');
    }
    emitTerminalAudit(ctx, deps);
    throw ctx.error;
  }
}
