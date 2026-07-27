import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Env } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { VERSION } from '../version.js';
import { registerGateway } from '../gateway/routes.js';
import type { PipelineDeps } from '../gateway/pipeline.js';
import { registerTaskClassRegistration } from '../policy/registration.js';
import { registerBillingFeed } from '../ledger/billing-route.js';
import { registerAdminApi, type AdminApiOptions } from '../admin-api/routes.js';

export interface BuildAppOptions {
  env: Env;
  /** When provided, the AI gateway is mounted. Absent → bare skeleton (health/version only). */
  gateway?: {
    deps: PipelineDeps;
    heartbeatMs?: number;
  };
  /** When provided, the session-authed admin API is mounted (Phase 11). */
  adminApi?: Omit<AdminApiOptions, 'deps'> & { deps?: PipelineDeps };
}

/** Builds the Fastify instance. Kept separate from listen() so tests can inject() without a socket. */
export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const { env } = opts;
  const app = Fastify({
    loggerInstance: createLogger(
      env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
      env.NODE_ENV === 'development',
    ) as FastifyBaseLogger,
    bodyLimit: env.ROUTER_MAX_BODY_BYTES,
    requestIdHeader: 'x-request-id',
  });

  /**
   * Global error handler (QA-D finding #1): any error that escapes a route returns a generic
   * taxonomy-shaped body. Fastify's default echoes `err.message`, which for a DB failure is the
   * full SQL text plus bound parameter values — a schema/data disclosure to the caller.
   * The real error is logged server-side only.
   */
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err, url: req.url }, 'unhandled route error');
      return reply.code(500).send({ error: { message: 'internal error', code: 'unknown' } });
    }
    // client-side errors from Fastify itself (body too large, malformed JSON, …)
    return reply.code(status).send({
      error: { message: err.message, type: 'invalid_request_error', code: 'invalid_request' },
    });
  });

  app.get('/healthz', () => ({ status: 'ok' }));

  if (opts.gateway?.deps.metrics) {
    const metrics = opts.gateway.deps.metrics;
    // internal-network only — never route through Caddy (docs/appliance.md)
    app.get('/metrics', async (_req, reply) => {
      return reply.header('content-type', 'text/plain; version=0.0.4').send(await metrics.render());
    });
  }

  app.get('/version', () => ({
    name: 'vibe-ai-router',
    version: VERSION,
  }));

  if (opts.gateway) {
    registerGateway(app, {
      deps: opts.gateway.deps,
      limits: {
        maxBodyBytes: env.ROUTER_MAX_BODY_BYTES,
        maxMessages: env.ROUTER_MAX_MESSAGES,
        maxJsonDepth: env.ROUTER_MAX_JSON_DEPTH,
      },
      ...(opts.gateway.heartbeatMs !== undefined ? { heartbeatMs: opts.gateway.heartbeatMs } : {}),
    });
    registerTaskClassRegistration(app, {
      db: opts.gateway.deps.db,
      engine: opts.gateway.deps.engine,
    });
    registerBillingFeed(app, { db: opts.gateway.deps.db });
  }

  if (opts.adminApi && opts.gateway) {
    registerAdminApi(app, { ...opts.adminApi, deps: opts.adminApi.deps ?? opts.gateway.deps });

    // serve the built admin UI when present (production container; dev uses vite proxy).
    // path differs between tsx (src/server) and compiled (dist/src/server) layouts:
    const here = dirname(fileURLToPath(import.meta.url));
    const uiDist = [join(here, '../../ui/dist'), join(here, '../../../ui/dist')].find((p) =>
      existsSync(join(p, 'index.html')),
    );
    if (uiDist) {
      void app.register(fastifyStatic, { root: uiDist, prefix: '/' });
      app.setNotFoundHandler((req, reply) => {
        // SPA fallback for UI routes only; API 404s stay JSON
        if (
          req.method === 'GET' &&
          !req.url.startsWith('/v1/') &&
          !req.url.startsWith('/admin') &&
          !req.url.startsWith('/healthz') &&
          !req.url.startsWith('/version')
        ) {
          return reply.sendFile('index.html');
        }
        return reply.code(404).send({ error: { message: 'not found', code: 'invalid_request' } });
      });
    }
  }

  return app;
}
