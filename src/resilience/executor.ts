/**
 * Resilient execution (10.1/10.3/10.4/10.5): retries with backoff on retryable codes, breaker
 * gating, fallback-chain advancement (each hop re-passes capability + sensitivity via
 * routeForModel), streaming fallback only before the first content chunk, total + idle
 * timeouts, load-shed guard. Every hop is audited.
 */
import { isLocalKind } from '../../db/schema.js';
import type { AIResponse, StreamChunk } from '../gateway/envelope.js';
import { RETRYABLE_CODES, RouterError, toRouterError } from '../gateway/errors.js';
import { routeForModel, type PipelineCtx, type PipelineDeps, type RouteDecision } from '../gateway/pipeline.js';
import { verifyResponse, type SoftFinding, type VerifyFinding } from '../gateway/verify.js';
import { clampToModel, selectModel } from '../policy/engine.js';
import { MAX_RETRIES, retryDelayMs, sleep } from './backoff.js';
import type { CircuitBreaker } from './breaker.js';
import type { LoadShedGuard } from './shed.js';

export interface ResilienceConfig {
  breaker: CircuitBreaker;
  shed: LoadShedGuard;
  totalTimeoutMs: number;
  streamIdleTimeoutMs: number;
  /**
   * Verify each hop's RESULT, not just its status code (default on). A 200 carrying an
   * unusable result becomes a retryable `invalid_response`, so retry → fallback → breaker
   * all engage. Off restores pre-verification behavior: any 200 is a success.
   */
  verifyResponses?: boolean;
}

/** Marker on an abort reason so a hop failure can be classified as a timeout, not a provider fault. */
class TimeoutAbort extends Error {}

interface Composite {
  signal: AbortSignal;
  dispose: () => void;
  /** true once the total-timeout timer has fired */
  timedOut: () => boolean;
  /**
   * Stop the total-timeout clock (streams call this on the first chunk — after that the
   * per-hop idle timer governs, so a long-but-progressing generation is never walled by the
   * total budget). Q-077: the 120s total used to kill every 32k-token local generation.
   */
  clearTotalTimeout: () => void;
}

function compositeSignal(client: AbortSignal, totalMs: number): Composite {
  const controller = new AbortController();
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    fired = true;
    controller.abort(new TimeoutAbort('total timeout'));
  }, totalMs);
  const clearTotalTimeout = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const onClientAbort = (): void => controller.abort(new Error('client abort'));
  if (client.aborted) onClientAbort();
  else client.addEventListener('abort', onClientAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTotalTimeout();
      client.removeEventListener('abort', onClientAbort);
    },
    timedOut: () => fired,
    clearTotalTimeout,
  };
}

function auditRejected(
  ctx: PipelineCtx,
  deps: PipelineDeps,
  model: string,
  reason: VerifyFinding['reason'],
  path?: string,
): void {
  if (!ctx.auth) return;
  deps.audit?.({
    firmId: ctx.auth.firmId,
    event: 'response_rejected',
    app: ctx.auth.app,
    ...(ctx.taskClass ? { taskClass: ctx.taskClass.key } : {}),
    model,
    requestHash: ctx.requestHash,
    // reason + schema PATH only — never the offending value (invariant 2)
    detail: { reason, ...(path ? { path } : {}) },
  });
}

/**
 * Structural-validation deviations on a hop that still SERVED (item C, Vibe 1040 follow-ups):
 * one audit row per response with the count and the first path, plus a metric — so an operator
 * can see a class whose model keeps inventing enum members without the request having failed.
 */
function auditSoftFindings(ctx: PipelineCtx, deps: PipelineDeps, model: string, soft: SoftFinding[]): void {
  deps.metrics?.responseSoftFindingsTotal.inc({ reason: 'schema_enum_miss' }, soft.length);
  if (!ctx.auth) return;
  deps.audit?.({
    firmId: ctx.auth.firmId,
    event: 'response_soft_finding',
    app: ctx.auth.app,
    ...(ctx.taskClass ? { taskClass: ctx.taskClass.key } : {}),
    model,
    requestHash: ctx.requestHash,
    // count + first schema PATH only — never the offending value (invariant 2)
    detail: { reason: 'schema_enum_miss', count: soft.length, path: soft[0]!.path },
  });
}

function auditHop(ctx: PipelineCtx, deps: PipelineDeps, from: string, to: string, reason: string): void {
  deps.metrics?.fallbackHopsTotal.inc();
  if (!ctx.auth) return;
  deps.audit?.({
    firmId: ctx.auth.firmId,
    event: 'fallback_hop',
    app: ctx.auth.app,
    ...(ctx.taskClass ? { taskClass: ctx.taskClass.key } : {}),
    requestHash: ctx.requestHash,
    detail: { from, to, reason: reason.slice(0, 300) },
  });
}

/** candidate models in order: policy-selected primary, then the fallback chain (deduped). */
export function candidateModels(ctx: PipelineCtx): string[] {
  const effective = ctx.effective;
  if (!effective) throw new RouterError('unknown', 'pipeline ordering violation');
  const primary = selectModel(effective, ctx.envelope);
  const ids = [primary.id, ...effective.policy.fallbackChain.filter((id) => id !== primary.id)];
  return ids;
}

/**
 * Envelope for ONE hop (Q-072): when the primary is local, the scrub stage leaves the
 * original envelope for local hops and stashes the redacted copy for cloud hops here.
 */
function hopEnvelope(route: RouteDecision, ctx: PipelineCtx): PipelineCtx['envelope'] {
  const base = !isLocalKind(route.model.providerKind) && ctx.cloudEnvelope ? ctx.cloudEnvelope : ctx.envelope;
  // per-hop, never written back: the next hop may be a model with a HIGHER ceiling, and
  // mutating the shared envelope would leave it clamped to the smallest model in the chain
  return clampToModel(base, route.model);
}

/** Audited once per hop when the model's own output ceiling is below what the caller asked. */
function auditClamp(ctx: PipelineCtx, deps: PipelineDeps, route: RouteDecision): void {
  const requested = ctx.envelope.maxTokens;
  const limit = route.model.maxOutput;
  if (!ctx.auth || requested === undefined || limit === null || limit === undefined || requested <= limit) return;
  deps.audit?.({
    firmId: ctx.auth.firmId,
    event: 'max_tokens_clamped',
    app: ctx.auth.app,
    ...(ctx.taskClass ? { taskClass: ctx.taskClass.key } : {}),
    model: route.model.canonicalId,
    requestHash: ctx.requestHash,
    detail: { requested, served: limit },
  });
}

async function executeHopOnce(
  route: RouteDecision,
  ctx: PipelineCtx,
  signal: AbortSignal,
): Promise<AIResponse> {
  return route.adapter.execute(hopEnvelope(route, ctx), route.executeCtx, signal);
}

/** retry loop for ONE hop (10.1): retryable codes only, ≤2 retries, Retry-After respected. */
async function executeHopWithRetries(
  route: RouteDecision,
  ctx: PipelineCtx,
  deps: PipelineDeps,
  cfg: ResilienceConfig,
  signal: AbortSignal,
): Promise<AIResponse> {
  let lastErr: RouterError | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) throw lastErr ?? new RouterError('unknown', 'aborted');
    try {
      const res = await executeHopOnce(route, ctx, signal);
      // RESULT verification (not just status): a 200 with an unusable body is a hop failure,
      // so it retries here and falls through to the next hop below — and is recorded against
      // the provider's health instead of leaving it green.
      if (cfg.verifyResponses !== false) {
        const soft: SoftFinding[] = [];
        const finding = verifyResponse(res, hopEnvelope(route, ctx), soft);
        if (finding) {
          auditRejected(ctx, deps, route.model.canonicalId, finding.reason, finding.path);
          deps.metrics?.responsesRejectedTotal.inc({ reason: finding.reason });
          throw new RouterError('invalid_response', finding.message, {
            detail: { reason: finding.reason, ...(finding.path ? { path: finding.path } : {}) },
          });
        }
        if (soft.length > 0) auditSoftFindings(ctx, deps, route.model.canonicalId, soft);
      }
      cfg.breaker.record(route.provider.id, true);
      deps.recordHealth?.(route.provider.id, ctx.auth!.firmId, route.provider.label, true);
      return res;
    } catch (err) {
      const rerr = toRouterError(err);
      lastErr = rerr;
      // client abort / total timeout is NOT a provider fault — recording it would open the
      // breaker on a healthy provider and mark it down (Q-077)
      if (!signal.aborted) {
        cfg.breaker.record(route.provider.id, false);
        deps.recordHealth?.(route.provider.id, ctx.auth!.firmId, route.provider.label, false);
      }
      // Truncation at max_tokens is DETERMINISTIC — a re-roll of the same model with the same
      // ceiling truncates again. Leave the retry loop immediately so the chain advances to a
      // model whose own max_output can actually hold the answer.
      if (rerr.code === 'invalid_response' && (rerr.detail as { reason?: string } | undefined)?.reason === 'json_truncated') {
        throw rerr;
      }
      if (!RETRYABLE_CODES.has(rerr.code) || attempt === MAX_RETRIES || signal.aborted) throw rerr;
      await sleep(retryDelayMs(attempt, rerr.retryAfterSeconds), signal).catch(() => {
        throw rerr;
      });
    }
  }
  throw lastErr ?? new RouterError('unknown', 'retry loop exhausted');
}

/**
 * On chain exhaustion, a hop that was never ELIGIBLE (policy-side skip:
 * capability_missing / policy_blocked) must not mask why an eligible hop
 * actually FAILED (provider-side, often retryable) — otherwise a dead vision
 * provider surfaces as a hard 400 instead of a retryable 502 (Q-092 review).
 */
export function preferError(prev: RouterError | undefined, next: RouterError): RouterError {
  const policySide = (c: RouterError['code']): boolean =>
    c === 'capability_missing' || c === 'policy_blocked';
  if (prev && policySide(next.code) && !policySide(prev.code)) return prev;
  return next;
}

/**
 * Non-streaming execution across the fallback chain (10.3). Provider-side failures advance to
 * the next hop; policy-side failures (capability/sensitivity/banned) skip the hop. On
 * exhaustion the most MEANINGFUL error propagates (provider-side outranks policy-side skips —
 * see preferError), latest within its class.
 */
export async function executeResilient(
  ctx: PipelineCtx,
  deps: PipelineDeps,
  cfg: ResilienceConfig,
  clientSignal: AbortSignal,
): Promise<AIResponse> {
  const effective = ctx.effective;
  if (!effective) throw new RouterError('unknown', 'pipeline ordering violation');
  const composite = compositeSignal(clientSignal, cfg.totalTimeoutMs);
  const { signal, dispose } = composite;
  try {
    let lastErr: RouterError | undefined;
    let previousModel = '';
    for (const modelId of candidateModels(ctx)) {
      if (signal.aborted) break; // client gone or total timeout — stop hopping
      const model = effective.modelsById.get(modelId);
      if (!model) continue;
      let route: RouteDecision;
      try {
        route = await routeForModel(model, ctx, deps); // re-validates capability + sensitivity per hop
      } catch (err) {
        const rerr = toRouterError(err);
        lastErr = preferError(lastErr, rerr);
        if (previousModel) auditHop(ctx, deps, previousModel, model.canonicalId, `hop skipped: ${rerr.message}`);
        previousModel = model.canonicalId;
        continue;
      }

      if (!cfg.breaker.allow(route.provider.id)) {
        lastErr = new RouterError('provider_unavailable', `circuit open for ${route.provider.label}`);
        auditHop(ctx, deps, previousModel || model.canonicalId, model.canonicalId, 'breaker open');
        previousModel = model.canonicalId;
        continue;
      }

      const release = await cfg.shed.acquire(route.provider.id, signal);
      if (release === null) {
        lastErr = new RouterError('rate_limited', 'upstream concurrency limit reached', {
          retryAfterSeconds: 1,
        });
        previousModel = model.canonicalId;
        continue;
      }
      try {
        if (previousModel) auditHop(ctx, deps, previousModel, model.canonicalId, lastErr?.message ?? 'fallback');
        auditClamp(ctx, deps, route);
        ctx.route = route; // the hop that actually serves
        return await executeHopWithRetries(route, ctx, deps, cfg, signal);
      } catch (err) {
        lastErr = toRouterError(err);
        previousModel = model.canonicalId;
        if (signal.aborted) break;
        // advance to next hop on provider-side failure (10.3)
      } finally {
        release();
      }
    }
    // a total-timeout abort surfaces as a provider timeout, not a generic 500 (Q-077)
    if (composite.timedOut()) {
      throw new RouterError('provider_unavailable', 'upstream timed out', {
        detail: { reason: 'total_timeout' },
      });
    }
    throw lastErr ?? new RouterError('provider_unavailable', 'no usable model in policy chain');
  } finally {
    dispose();
  }
}

/**
 * Streaming execution (10.4): fallback advances ONLY before the first content chunk reaches
 * the consumer. Once anything is yielded, failures terminate the stream (the relay emits a
 * clean error event). Idle timeout aborts stalled upstreams.
 */
export async function* executeResilientStream(
  ctx: PipelineCtx,
  deps: PipelineDeps,
  cfg: ResilienceConfig,
  clientSignal: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const effective = ctx.effective;
  if (!effective) throw new RouterError('unknown', 'pipeline ordering violation');
  const composite = compositeSignal(clientSignal, cfg.totalTimeoutMs);
  const { signal, dispose } = composite;
  try {
    let lastErr: RouterError | undefined;
    let previousModel = '';
    for (const modelId of candidateModels(ctx)) {
      if (signal.aborted) break;
      const model = effective.modelsById.get(modelId);
      if (!model) continue;
      let route: RouteDecision;
      try {
        route = await routeForModel(model, ctx, deps);
      } catch (err) {
        lastErr = preferError(lastErr, toRouterError(err));
        previousModel = model.canonicalId;
        continue;
      }
      if (!cfg.breaker.allow(route.provider.id)) {
        lastErr = new RouterError('provider_unavailable', `circuit open for ${route.provider.label}`);
        auditHop(ctx, deps, previousModel || model.canonicalId, model.canonicalId, 'breaker open');
        previousModel = model.canonicalId;
        continue;
      }
      const release = await cfg.shed.acquire(route.provider.id, signal);
      if (release === null) {
        lastErr = new RouterError('rate_limited', 'upstream concurrency limit reached', {
          retryAfterSeconds: 1,
        });
        previousModel = model.canonicalId;
        continue;
      }

      // `contentSeen` gates the no-splice rule: it flips on the first chunk that carries
      // actual OUTPUT (text or a tool call). Non-content frames (finish/usage/keep-alive) are
      // buffered until then, so a hop that ends without ever producing output has relayed
      // NOTHING to the consumer and can still be replaced by the next hop (10.4 is preserved —
      // once real content is out, no provider is ever spliced in behind it).
      let contentSeen = false;
      const pending: StreamChunk[] = [];
      let idleFired = false;
      // idle watchdog (10.5): armed ONLY after the first chunk (Q-077). Time-to-first-token
      // — Ollama cold-load of a 14B model can take minutes — is bounded by the TOTAL timeout,
      // not this 60s idle timer; the idle timer only guards inter-chunk stalls.
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const hopController = new AbortController();
      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleFired = true;
          hopController.abort(new TimeoutAbort('stream idle timeout'));
        }, cfg.streamIdleTimeoutMs);
      };
      const onOuter = (): void => hopController.abort(signal.reason);
      signal.addEventListener('abort', onOuter, { once: true });

      try {
        if (previousModel) auditHop(ctx, deps, previousModel, model.canonicalId, lastErr?.message ?? 'fallback');
        auditClamp(ctx, deps, route);
        ctx.route = route;
        const stream = route.adapter.executeStream(hopEnvelope(route, ctx), route.executeCtx, hopController.signal);
        for await (const chunk of stream) {
          armIdle();
          const isContent =
            chunk.type === 'text_delta' || chunk.type === 'tool_call_start' || chunk.type === 'tool_call_delta';
          if (!contentSeen && !isContent) {
            pending.push(chunk); // hold back: this hop may still turn out to be replaceable
            continue;
          }
          if (!contentSeen) {
            // first CONTENT chunk: the generation is genuinely progressing — stop the
            // total-timeout wall and hand off to the idle timer so a long 32k generation can
            // run to completion. Deliberately NOT on any frame: a provider emitting nothing
            // but keep-alives would otherwise clear the wall and hang until the client gave up.
            composite.clearTotalTimeout();
            contentSeen = true;
            for (const held of pending) yield held;
            pending.length = 0;
          }
          yield chunk;
        }
        if (!contentSeen) {
          // completed without ever producing output — same class of fault as an empty
          // non-streaming body, and nothing has reached the consumer, so fall back.
          throw new RouterError('invalid_response', 'provider produced a stream with no content', {
            detail: { reason: 'empty_response' },
          });
        }
        cfg.breaker.record(route.provider.id, true);
        // stream health is recorded by the SSE relay (routes.ts) — don't double-count here
        return;
      } catch (err) {
        const rerr = idleFired
          ? new RouterError('provider_unavailable', 'upstream stalled (idle timeout)', {
              detail: { reason: 'stream_idle_timeout' },
            })
          : toRouterError(err);
        // don't blame the provider for a client abort or a total/idle timeout (Q-077)
        if (!signal.aborted && !idleFired) {
          cfg.breaker.record(route.provider.id, false);
          deps.recordHealth?.(route.provider.id, ctx.auth!.firmId, route.provider.label, false);
        }
        if (rerr.code === 'invalid_response') {
          auditRejected(ctx, deps, route.model.canonicalId, 'empty_response');
          deps.metrics?.responsesRejectedTotal.inc({ reason: 'empty_response' });
        }
        if (contentSeen || signal.aborted || idleFired) {
          // after first chunk (or on abort/timeout): fail cleanly, never splice providers (10.4)
          throw rerr;
        }
        lastErr = rerr;
        previousModel = model.canonicalId;
        // advance to next hop
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        signal.removeEventListener('abort', onOuter);
        release();
      }
    }
    if (composite.timedOut()) {
      throw new RouterError('provider_unavailable', 'upstream timed out before first token', {
        detail: { reason: 'total_timeout' },
      });
    }
    throw lastErr ?? new RouterError('provider_unavailable', 'no usable model in policy chain');
  } finally {
    dispose();
  }
}
