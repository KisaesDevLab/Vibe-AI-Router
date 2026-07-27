import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Env } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { VERSION } from '../version.js';
import { registerGateway } from '../gateway/routes.js';
import type { PipelineDeps } from '../gateway/pipeline.js';
import { registerTaskClassRegistration } from '../policy/registration.js';

export interface BuildAppOptions {
  env: Env;
  /** When provided, the AI gateway is mounted. Absent → bare skeleton (health/version only). */
  gateway?: {
    deps: PipelineDeps;
    heartbeatMs?: number;
  };
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

  app.get('/healthz', () => ({ status: 'ok' }));

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
  }

  return app;
}
