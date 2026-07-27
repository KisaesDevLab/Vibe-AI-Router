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
}
