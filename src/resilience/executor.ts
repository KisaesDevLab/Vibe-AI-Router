/**
 * Resilient execution (10.1/10.3/10.4/10.5): retries with backoff on retryable codes, breaker
 * gating, fallback-chain advancement (each hop re-passes capability + sensitivity via
 * routeForModel), streaming fallback only before the first content chunk, total + idle
 * timeouts, load-shed guard. Every hop is audited.
 */
import type { AIResponse, StreamChunk } from '../gateway/envelope.js';
import { RETRYABLE_CODES, RouterError, toRouterError } from '../gateway/errors.js';
import { routeForModel, type PipelineCtx, type PipelineDeps, type RouteDecision } from '../gateway/pipeline.js';
import { selectModel } from '../policy/engine.js';
import { MAX_RETRIES, retryDelayMs, sleep } from './backoff.js';
import type { CircuitBreaker } from './breaker.js';
import type { LoadShedGuard } from './shed.js';

export interface ResilienceConfig {
  breaker: CircuitBreaker;
  shed: LoadShedGuard;
  totalTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

function compositeSignal(client: AbortSignal, totalMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('total timeout')), totalMs);
  const onClientAbort = (): void => controller.abort(new Error('client abort'));
  if (client.aborted) onClientAbort();
  else client.addEventListener('abort', onClientAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      client.removeEventListener('abort', onClientAbort);
    },
  };
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

async function executeHopOnce(
  route: RouteDecision,
  ctx: PipelineCtx,
  signal: AbortSignal,
): Promise<AIResponse> {
  return route.adapter.execute(ctx.envelope, route.executeCtx, signal);
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
      cfg.breaker.record(route.provider.id, true);
      deps.recordHealth?.(route.provider.id, ctx.auth!.firmId, route.provider.label, true);
      return res;
    } catch (err) {
      const rerr = toRouterError(err);
      lastErr = rerr;
      cfg.breaker.record(route.provider.id, false);
      deps.recordHealth?.(route.provider.id, ctx.auth!.firmId, route.provider.label, false);
      if (!RETRYABLE_CODES.has(rerr.code) || attempt === MAX_RETRIES || signal.aborted) throw rerr;
      await sleep(retryDelayMs(attempt, rerr.retryAfterSeconds), signal).catch(() => {
        throw rerr;
      });
    }
  }
  throw lastErr ?? new RouterError('unknown', 'retry loop exhausted');
}

/**
 * Non-streaming execution across the fallback chain (10.3). Provider-side failures advance to
 * the next hop; policy-side failures (capability/sensitivity/banned) skip the hop. The LAST
 * error propagates when the chain is exhausted.
 */
export async function executeResilient(
  ctx: PipelineCtx,
  deps: PipelineDeps,
  cfg: ResilienceConfig,
  clientSignal: AbortSignal,
): Promise<AIResponse> {
  const effective = ctx.effective;
  if (!effective) throw new RouterError('unknown', 'pipeline ordering violation');
  const { signal, dispose } = compositeSignal(clientSignal, cfg.totalTimeoutMs);
  try {
    let lastErr: RouterError | undefined;
    let previousModel = '';
    for (const modelId of candidateModels(ctx)) {
      const model = effective.modelsById.get(modelId);
      if (!model) continue;
      let route: RouteDecision;
      try {
        route = await routeForModel(model, ctx, deps); // re-validates capability + sensitivity per hop
      } catch (err) {
        const rerr = toRouterError(err);
        lastErr = rerr;
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
  const { signal, dispose } = compositeSignal(clientSignal, cfg.totalTimeoutMs);
  try {
    let lastErr: RouterError | undefined;
    let previousModel = '';
    for (const modelId of candidateModels(ctx)) {
      const model = effective.modelsById.get(modelId);
      if (!model) continue;
      let route: RouteDecision;
      try {
        route = await routeForModel(model, ctx, deps);
      } catch (err) {
        lastErr = toRouterError(err);
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

      let yieldedAnything = false;
      // idle watchdog (10.5)
      const idleController = new AbortController();
      let idleTimer = setTimeout(() => idleController.abort(new Error('stream idle timeout')), cfg.streamIdleTimeoutMs);
      const resetIdle = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => idleController.abort(new Error('stream idle timeout')), cfg.streamIdleTimeoutMs);
      };
      const hopController = new AbortController();
      const onOuter = (): void => hopController.abort();
      const onIdle = (): void => hopController.abort(new Error('stream idle timeout'));
      signal.addEventListener('abort', onOuter, { once: true });
      idleController.signal.addEventListener('abort', onIdle, { once: true });

      try {
        if (previousModel) auditHop(ctx, deps, previousModel, model.canonicalId, lastErr?.message ?? 'fallback');
        ctx.route = route;
        const stream = route.adapter.executeStream(ctx.envelope, route.executeCtx, hopController.signal);
        for await (const chunk of stream) {
          resetIdle();
          yieldedAnything = true;
          yield chunk;
        }
        cfg.breaker.record(route.provider.id, true);
        deps.recordHealth?.(route.provider.id, ctx.auth!.firmId, route.provider.label, true);
        return;
      } catch (err) {
        const rerr = toRouterError(err);
        cfg.breaker.record(route.provider.id, false);
        deps.recordHealth?.(route.provider.id, ctx.auth!.firmId, route.provider.label, false);
        if (yieldedAnything || signal.aborted) {
          // after first chunk: fail cleanly, never splice providers mid-stream (10.4)
          throw rerr;
        }
        lastErr = rerr;
        previousModel = model.canonicalId;
        // advance to next hop
      } finally {
        clearTimeout(idleTimer);
        signal.removeEventListener('abort', onOuter);
        release();
      }
    }
    throw lastErr ?? new RouterError('provider_unavailable', 'no usable model in policy chain');
  } finally {
    dispose();
  }
}
