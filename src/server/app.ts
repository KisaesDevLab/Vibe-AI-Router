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

/**
 * Which surfaces this process serves (ROUTER_ROLE).
 *
 *   gateway — `/v1/*` for apps. NEVER publicly routed: it authenticates with app tokens and
 *             spends the firm's AI budget, so it stays on the internal network.
 *   console — the staff admin UI + `/admin-api/*`. Safe to put behind Caddy/TLS because it is
 *             session-authenticated and CSRF-guarded.
 *   both    — one process serves everything (dev default, and the pre-split deployment shape).
 *
 * Splitting them into two containers is what lets the console have a real HTTPS hostname
 * without publishing the gateway alongside it — the two surfaces shared a port before, so
 * exposing one exposed both.
 */
export type RouterRole = 'gateway' | 'console' | 'both';

export const servesGateway = (role: RouterRole): boolean => role === 'gateway' || role === 'both';
const servesConsole = (role: RouterRole): boolean => role === 'console' || role === 'both';

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

  /**
   * /healthz probes the DB (Q-073): the appliance healthcheck chain and the console
   * container's dependency wait both trust this endpoint, so "process is up" alone is a lie
   * when Postgres is down and every request 500s. Result cached 2s — the probe must not
   * become load. No deps wired (bare skeleton) → process-liveness only, as before.
   */
  const healthDb = opts.gateway?.deps.db ?? opts.adminApi?.deps?.db;
  let healthCache: { ok: boolean; at: number } = { ok: true, at: 0 };
  app.get('/healthz', async (_req, reply) => {
    if (!healthDb) return reply.send({ status: 'ok' });
    if (Date.now() - healthCache.at > 2_000) {
      const ok = await Promise.race([
        import('drizzle-orm').then(({ sql }) => healthDb.execute(sql`SELECT 1`)).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((r) => setTimeout(() => r(false), 1_500)),
      ]);
      healthCache = { ok, at: Date.now() };
    }
    if (!healthCache.ok) return reply.code(503).send({ status: 'degraded', db: 'unreachable' });
    return reply.send({ status: 'ok' });
  });

  app.get('/version', () => ({
    name: 'vibe-ai-router',
    version: VERSION,
  }));

  const role = env.ROUTER_ROLE;
  app.get('/role', () => ({ role })); // lets ops confirm what a container is actually serving

  // /metrics is internal-network only — never route through Caddy (docs/appliance.md). A
  // console container gets a Caddy vhost, so it must not carry the endpoint at all: the
  // appliance's routing.deny_paths blocks it at the edge, and gating it here means even a
  // misconfigured proxy has nothing to expose (per-task-class counts, provider names,
  // breaker state are firm-operational data). Gateway metrics live where the traffic is.
  if (opts.gateway?.deps.metrics && servesGateway(role)) {
    const metrics = opts.gateway.deps.metrics;
    app.get('/metrics', async (_req, reply) => {
      return reply.header('content-type', 'text/plain; version=0.0.4').send(await metrics.render());
    });
  }

  if (opts.gateway && servesGateway(role)) {
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
    registerBillingFeed(app, {
      db: opts.gateway.deps.db,
      engine: opts.gateway.deps.engine,
      ...(opts.gateway.deps.rateLimits
        ? { rateLimits: { perToken: opts.gateway.deps.rateLimits.perToken } }
        : {}),
    });
  }

  if (opts.adminApi && opts.gateway && servesConsole(role)) {
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
        // SPA fallback for UI routes only; API 404s stay JSON. /v1 is excluded even in
        // console-only mode: a console container must answer a stray gateway call with a
        // JSON 404, never the SPA shell (which would look like a 200 to a caller).
        if (
          req.method === 'GET' &&
          !req.url.startsWith('/v1/') &&
          !req.url.startsWith('/admin') &&
          !req.url.startsWith('/healthz') &&
          !req.url.startsWith('/metrics') &&
          !req.url.startsWith('/role') &&
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
