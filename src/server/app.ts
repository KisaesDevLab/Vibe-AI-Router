import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Env } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { VERSION } from '../version.js';

export interface BuildAppOptions {
  env: Env;
}

/** Builds the Fastify instance. Kept separate from listen() so tests can inject() without a socket. */
export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const { env } = opts;
  const app = Fastify({
    loggerInstance: createLogger(
      env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
      env.NODE_ENV === 'development',
    ) as FastifyBaseLogger,
    bodyLimit: 10 * 1024 * 1024, // tightened per-route in the gateway (Phase 2)
    requestIdHeader: 'x-request-id',
  });

  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/version', () => ({
    name: 'vibe-ai-router',
    version: VERSION,
  }));

  return app;
}
