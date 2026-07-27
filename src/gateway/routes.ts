/**
 * Gateway HTTP surface: POST /v1/chat/completions (OpenAI-compatible, 2.4) with SSE streaming
 * (2.7). Required header: X-Vibe-Task-Class (fail closed). Optional: X-Vibe-Engagement,
 * X-Vibe-Client, X-Vibe-User, X-Vibe-User-Role.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AIRequestMetadata, StreamChunk } from './envelope.js';
import { toEnvelope } from './envelope.js';
import { RouterError, errorBody, toRouterError } from './errors.js';
import { toChatCompletion, toChunkObjects } from './openai-shape.js';
import { emitTerminalAudit, newPipelineCtx, runPipeline, type PipelineDeps } from './pipeline.js';

export interface GatewayOptions {
  deps: PipelineDeps;
  limits: { maxBodyBytes: number; maxMessages: number; maxJsonDepth: number };
  /** SSE heartbeat interval; injectable for tests */
  heartbeatMs?: number;
}

function headerString(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function registerGateway(app: FastifyInstance, opts: GatewayOptions): void {
  const { deps, limits } = opts;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;

  app.post(
    '/v1/chat/completions',
    { bodyLimit: limits.maxBodyBytes },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const abort = new AbortController();
      // Client disconnect: the RESPONSE closes without finishing (req.raw 'close' fires on
      // normal request completion and must not be used). Propagated upstream ≤1 tick (2.7/10.9).
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) abort.abort();
      });

      try {
        const taskClass = headerString(req, 'x-vibe-task-class');
        if (!taskClass) {
          throw new RouterError('policy_blocked', 'missing required header X-Vibe-Task-Class');
        }
        const metadata: AIRequestMetadata = { app: 'unknown' }; // overwritten by auth stage
        const engagement = headerString(req, 'x-vibe-engagement');
        const client = headerString(req, 'x-vibe-client');
        const user = headerString(req, 'x-vibe-user');
        const userRole = headerString(req, 'x-vibe-user-role');
        if (engagement) metadata.engagementRef = engagement;
        if (client) metadata.clientRef = client;
        if (user) metadata.userId = user;
        if (userRole === 'admin' || userRole === 'partner' || userRole === 'staff')
          metadata.userRole = userRole;

        const envelope = toEnvelope(req.body, taskClass, metadata, {
          maxMessages: limits.maxMessages,
          maxJsonDepth: limits.maxJsonDepth,
        });
        const ctx = newPipelineCtx(envelope);
        void reply.header('x-request-id', ctx.requestId);

        const authHeader = req.headers.authorization;
        const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

        await runPipeline(ctx, deps, bearer, abort.signal);

        if (ctx.budgetWarnings?.length) {
          void reply.header('x-vibe-budget-warning', ctx.budgetWarnings.join(','));
        }

        if (!envelope.stream) {
          if (!ctx.response) throw new RouterError('unknown', 'pipeline produced no response');
          return await reply.code(200).send(toChatCompletion(ctx.requestId, ctx.response));
        }

        // ── SSE relay (2.7) ──────────────────────────────────────────────────
        if (!ctx.stream) throw new RouterError('unknown', 'pipeline produced no stream');
        reply.hijack(); // raw-socket mode: the relay owns the response from here
        // NB: writeHead replaces the header set — anything set via reply.header() before the
        // hijack is dropped, so budget warnings must be re-added here (QA-B finding #1)
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-request-id': ctx.requestId,
          ...(ctx.budgetWarnings?.length
            ? { 'x-vibe-budget-warning': ctx.budgetWarnings.join(',') }
            : {}),
        });
        reply.raw.flushHeaders?.();

        const heartbeat = setInterval(() => {
          if (!reply.raw.writableEnded) reply.raw.write(': heartbeat\n\n');
        }, heartbeatMs);
        heartbeat.unref?.();

        const model = ctx.route?.model.canonicalId ?? 'unknown';
        let first = true;
        let finishChunk: StreamChunk | undefined;
        try {
          for await (const chunk of ctx.stream) {
            if (abort.signal.aborted) break;
            if (chunk.type === 'finish') finishChunk = chunk;
            for (const obj of toChunkObjects(ctx.requestId, model, chunk, first)) {
              reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
            }
            first = false;
          }
          if (!abort.signal.aborted) reply.raw.write('data: [DONE]\n\n');
        } catch (streamErr) {
          // mid-stream failure: emit a terminal error event, never splice providers (10.4)
          const rerr = toRouterError(streamErr);
          if (!reply.raw.writableEnded) {
            reply.raw.write(`data: ${JSON.stringify(errorBody(rerr))}\n\n`);
            reply.raw.write('data: [DONE]\n\n');
          }
          ctx.error = rerr;
        } finally {
          clearInterval(heartbeat);
          // usage captured from final chunk → single ledger row for the stream (9.3)
          if (finishChunk?.type === 'finish' && finishChunk.usage && ctx.route) {
            ctx.response = {
              message: { role: 'assistant', content: '' },
              finishReason: finishChunk.finishReason,
              usage: finishChunk.usage,
              served: {
                model,
                providerId: ctx.route.provider.id,
                latencyMs: Date.now() - ctx.startedAt,
              },
            };
          }
          if (abort.signal.aborted && !ctx.error) ctx.error = new RouterError('unknown', 'client aborted');
          // stream outcome for passive health monitoring (client abort is not a provider fault)
          if (ctx.route && ctx.auth && !abort.signal.aborted) {
            deps.recordHealth?.(
              ctx.route.provider.id,
              ctx.auth.firmId,
              ctx.route.provider.label,
              ctx.error === undefined,
            );
          }
          try {
            await deps.ledger.write(ctx);
          } catch (ledgerErr) {
            deps.log.error({ err: ledgerErr, requestId: ctx.requestId }, 'ledger write failed');
          }
          emitTerminalAudit(ctx, deps);
          reply.raw.end();
        }
        return reply;
      } catch (err) {
        const rerr = toRouterError(err);
        if (rerr.code === 'unknown') {
          deps.log.error({ err, url: req.url }, 'gateway internal error');
        }
        if (rerr.retryAfterSeconds !== undefined) {
          void reply.header('retry-after', String(rerr.retryAfterSeconds));
        }
        return reply.code(rerr.status).send(errorBody(rerr));
      }
    },
  );
}
