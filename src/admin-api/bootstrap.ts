/**
 * Bootstrap admin surface (pre-Phase-11): operational endpoints gated by ADMIN_BOOTSTRAP_TOKEN.
 * When the env var is unset the routes are NOT REGISTERED at all (fail closed, Q-018).
 * Phase 11 replaces this with session-authenticated admin routes.
 */
import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { runCatalogSync } from '../catalog/scheduler.js';

function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function registerBootstrapAdmin(
  app: FastifyInstance,
  opts: { db: Db; log: Logger; adminToken: string },
): void {
  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const presented = req.headers['x-admin-token'];
    if (typeof presented !== 'string' || !tokenMatches(presented, opts.adminToken)) {
      void reply.code(401).send({ error: { message: 'admin token required', code: 'auth_error' } });
      return false;
    }
    return true;
  };

  app.post('/admin/catalog/sync', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const report = await runCatalogSync(opts.db, opts.log);
    if (!report) {
      return reply.code(502).send({ error: { message: 'sync failed — see audit log', code: 'unknown' } });
    }
    return reply.send({
      added: report.added.length,
      updated: report.updated.length,
      pricingChanged: report.pricingChanged.length,
      deprecated: report.deprecated,
      skipped: report.skipped.length,
      unchanged: report.unchanged,
    });
  });
}
