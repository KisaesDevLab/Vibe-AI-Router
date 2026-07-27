/**
 * Bootstrap admin surface (pre-Phase-11): operational endpoints gated by ADMIN_BOOTSTRAP_TOKEN.
 * When the env var is unset the routes are NOT REGISTERED at all (fail closed, Q-018).
 * Phase 11 replaces this with session-authenticated admin routes.
 */
import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { providers } from '../../db/schema.js';
import { runCatalogSync } from '../catalog/scheduler.js';
import type { CredentialVault } from '../vault/service.js';
import type { ProviderAdapter } from '../adapters/contract.js';
import type { PolicyEngine } from '../policy/engine.js';
import { exportPolicies, importPolicies } from '../policy/save.js';
import { auditToCsv, queryAudit } from '../protect/audit.js';
import { firms } from '../../db/schema.js';
import { RouterError, errorBody, toRouterError } from '../gateway/errors.js';

function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface BootstrapAdminOptions {
  db: Db;
  log: Logger;
  adminToken: string;
  /** present only when MASTER_KEY is configured */
  vault?: CredentialVault;
  adapterFor?: (kind: string) => ProviderAdapter | undefined;
  /** policy engine for export/import (Phase 7) */
  engine?: PolicyEngine;
}

export function registerBootstrapAdmin(app: FastifyInstance, opts: BootstrapAdminOptions): void {
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

  // ── credential lifecycle (Phase 6) — WRITE-ONLY: no endpoint ever returns key material ────
  const vaultOr503 = (reply: FastifyReply): CredentialVault | undefined => {
    if (!opts.vault) {
      void reply
        .code(503)
        .send({ error: { message: 'vault unavailable — MASTER_KEY not configured', code: 'unknown' } });
      return undefined;
    }
    return opts.vault;
  };

  app.post('/admin/providers/:providerId/credentials', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const vault = vaultOr503(reply);
    if (!vault) return reply;
    const params = z.object({ providerId: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ apiKey: z.string().min(8) }).safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(errorBody(new RouterError('invalid_request', 'providerId + apiKey required')));
    }
    try {
      const meta = await vault.add(params.data.providerId, body.data.apiKey);
      return await reply.code(201).send(meta); // metadata only: id/last4/status/key_version
    } catch (err) {
      const rerr = toRouterError(err);
      return reply.code(rerr.status).send(errorBody(rerr));
    }
  });

  app.get('/admin/providers/:providerId/credentials', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const vault = vaultOr503(reply);
    if (!vault) return reply;
    const params = z.object({ providerId: z.string().uuid() }).safeParse(req.params);
    if (!params.success)
      return reply.code(400).send(errorBody(new RouterError('invalid_request', 'bad providerId')));
    return reply.send(await vault.list(params.data.providerId));
  });

  app.post('/admin/credentials/:credentialId/promote', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const vault = vaultOr503(reply);
    if (!vault) return reply;
    const params = z.object({ credentialId: z.string().uuid() }).safeParse(req.params);
    if (!params.success)
      return reply.code(400).send(errorBody(new RouterError('invalid_request', 'bad credentialId')));
    try {
      return await reply.send(await vault.promote(params.data.credentialId));
    } catch (err) {
      const rerr = toRouterError(err);
      return reply.code(rerr.status).send(errorBody(rerr));
    }
  });

  app.post('/admin/credentials/:credentialId/revoke', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const vault = vaultOr503(reply);
    if (!vault) return reply;
    const params = z.object({ credentialId: z.string().uuid() }).safeParse(req.params);
    if (!params.success)
      return reply.code(400).send(errorBody(new RouterError('invalid_request', 'bad credentialId')));
    try {
      await vault.revoke(params.data.credentialId);
      return await reply.send({ ok: true });
    } catch (err) {
      const rerr = toRouterError(err);
      return reply.code(rerr.status).send(errorBody(rerr));
    }
  });

  app.post('/admin/providers/:providerId/test', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const vault = vaultOr503(reply);
    if (!vault) return reply;
    const params = z.object({ providerId: z.string().uuid() }).safeParse(req.params);
    const body = z
      .object({ credentialId: z.string().uuid().optional(), model: z.string().optional() })
      .safeParse(req.body ?? {});
    if (!params.success || !body.success)
      return reply.code(400).send(errorBody(new RouterError('invalid_request', 'bad request')));
    const provider = await opts.db.query.providers.findFirst({
      where: eq(providers.id, params.data.providerId),
    });
    if (!provider)
      return reply.code(400).send(errorBody(new RouterError('invalid_request', 'provider not found')));
    const adapter = opts.adapterFor?.(provider.kind);
    if (!adapter)
      return reply.code(400).send(errorBody(new RouterError('invalid_request', 'no adapter for provider kind')));
    try {
      const result = await vault.test(params.data.providerId, adapter, {
        ...(body.data.credentialId ? { credentialId: body.data.credentialId } : {}),
        ...(body.data.model ? { model: body.data.model } : {}),
      });
      return await reply.send(result);
    } catch (err) {
      const rerr = toRouterError(err);
      return reply.code(rerr.status).send(errorBody(rerr));
    }
  });

  // ── policy export / import (7.9) — single-firm appliance: first firm is the firm ─────────
  const firmId = async (): Promise<string | undefined> =>
    (await opts.db.query.firms.findFirst({ orderBy: firms.createdAt }))?.id;

  app.get('/admin/policies/export', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const engine = opts.engine;
    if (!engine) return reply.code(503).send({ error: { message: 'engine unavailable', code: 'unknown' } });
    const id = await firmId();
    if (!id) return reply.code(400).send(errorBody(new RouterError('invalid_request', 'no firm exists')));
    return reply.send(await exportPolicies(opts.db, id));
  });

  app.post('/admin/policies/import', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const engine = opts.engine;
    if (!engine) return reply.code(503).send({ error: { message: 'engine unavailable', code: 'unknown' } });
    const id = await firmId();
    if (!id) return reply.code(400).send(errorBody(new RouterError('invalid_request', 'no firm exists')));
    try {
      return await reply.send(await importPolicies(opts.db, engine, id, req.body));
    } catch (err) {
      const rerr = toRouterError(err);
      return reply.code(rerr.status).send(errorBody(rerr));
    }
  });

  // ── audit query + CSV export (8.7) ────────────────────────────────────────
  const auditQuerySchema = z.object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    event: z.string().optional(),
    app: z.string().optional(),
    user: z.string().uuid().optional(),
    task_class: z.string().optional(),
    limit: z.coerce.number().int().positive().max(5000).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  });

  const runAuditQuery = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Awaited<ReturnType<typeof queryAudit>> | undefined> => {
    const id = await firmId();
    if (!id) {
      void reply.code(400).send(errorBody(new RouterError('invalid_request', 'no firm exists')));
      return undefined;
    }
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      void reply.code(400).send(errorBody(new RouterError('invalid_request', 'bad audit query')));
      return undefined;
    }
    const q = parsed.data;
    return queryAudit(opts.db, {
      firmId: id,
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
      ...(q.event ? { event: q.event } : {}),
      ...(q.app ? { app: q.app } : {}),
      ...(q.user ? { userId: q.user } : {}),
      ...(q.task_class ? { taskClass: q.task_class } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.offset !== undefined ? { offset: q.offset } : {}),
    });
  };

  app.get('/admin/audit', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const rows = await runAuditQuery(req, reply);
    if (!rows) return reply;
    return reply.send(rows);
  });

  app.get('/admin/audit.csv', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const rows = await runAuditQuery(req, reply);
    if (!rows) return reply;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="audit.csv"')
      .send(auditToCsv(rows));
  });
}
