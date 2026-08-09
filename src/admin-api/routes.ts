/**
 * Admin REST API (11.1) — session-authenticated (admin role), zod-validated, every mutation
 * audited. Serves the React admin UI. Mutations additionally require the `x-vibe-admin: 1`
 * header (CSRF belt on top of SameSite=Strict cookies).
 */
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import {
  appTokens,
  firms,
  isLocalKind,
  models,
  providerCredentials,
  providers,
  taskClasses,
  users,
  PROVIDER_KINDS,
} from '../../db/schema.js';
import { RouterError, errorBody, toRouterError } from '../gateway/errors.js';
import {
  emitTerminalAudit,
  newPipelineCtx,
  stageAdapt,
  stageBudget,
  stagePolicy,
  stageResolveTaskClass,
  stageRoute,
  stageScrub,
  type PipelineDeps,
} from '../gateway/pipeline.js';
import { toEnvelope } from '../gateway/envelope.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { checkBaseUrlWithDns } from '../lib/ssrf.js';
import { safeString } from '../lib/safe-string.js';
import { queryAudit, auditToCsv } from '../protect/audit.js';
import { savePolicy, exportPolicies, importPolicies } from '../policy/save.js';
import {
  createCustomModel,
  effectiveCapabilities,
  retireCustomModel,
  setCapabilityOverrides,
} from '../catalog/service.js';
import { latencyStats, ledgerRows, rowsToCsv, spendBy } from '../ledger/aggregate.js';
import { currentPeriod } from '../ledger/budget.js';
import { buildWispData, renderWispDocx } from '../ops/wisp.js';
import type { CredentialVault } from '../vault/service.js';
import type { ProviderAdapter } from '../adapters/contract.js';
import type { BreakerSnapshot } from '../resilience/breaker.js';
import {
  SESSION_COOKIE,
  SessionStore,
  clearSessionCookie,
  parseCookies,
  setSessionCookie,
  type SessionData,
} from './session.js';

export interface AdminApiOptions {
  deps: PipelineDeps;
  sessions: SessionStore;
  secureCookies: boolean;
  vault?: CredentialVault;
  adapterFor: (kind: string) => ProviderAdapter | undefined;
  breakerSnapshot?: () => BreakerSnapshot[];
  /** ledger metadata retention (days) — surfaced in the WISP appendix; absent = indefinite */
  retentionDays?: number;
}

/**
 * A real scrypt hash of a random secret, computed once and reused, so failed logins for
 * unknown emails cost the same as failed logins for known ones (timing-oracle defense).
 */
let dummyHashPromise: Promise<string> | undefined;
function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(24).toString('base64'));
  return dummyHashPromise;
}

export function registerAdminApi(app: FastifyInstance, opts: AdminApiOptions): void {
  const db: Db = opts.deps.db;
  // warm the dummy hash at boot — computing it lazily inside the first unknown-email login
  // would itself be a timing signal (the very oracle we are closing)
  void dummyPasswordHash();

  const sessionOf = (req: FastifyRequest): SessionData | undefined =>
    opts.sessions.get(parseCookies(req)[SESSION_COOKIE]);

  const requireAdmin = (req: FastifyRequest, reply: FastifyReply): SessionData | undefined => {
    const session = sessionOf(req);
    if (!session || session.role !== 'admin') {
      void reply.code(401).send(errorBody(new RouterError('auth_error', 'admin session required')));
      return undefined;
    }
    if (req.method !== 'GET' && req.headers['x-vibe-admin'] !== '1') {
      void reply.code(403).send(errorBody(new RouterError('policy_blocked', 'missing x-vibe-admin header')));
      return undefined;
    }
    return session;
  };

  const auditConfig = (
    session: SessionData,
    entity: string,
    entityId: string,
    action: 'create' | 'update' | 'delete',
    after?: Record<string, string | number | boolean | null>,
    before?: Record<string, string | number | boolean | null>,
  ): void => {
    opts.deps.audit?.({
      firmId: session.firmId,
      userId: session.userId,
      event: 'config_change',
      detail: { entity, entityId, action, ...(before ? { before } : {}), ...(after ? { after } : {}) },
    });
  };

  const fail = (reply: FastifyReply, err: unknown): FastifyReply => {
    const rerr = toRouterError(err);
    return reply.code(rerr.status).send(errorBody(rerr));
  };

  /**
   * Guard for mutations of GLOBAL suite-wide tables — task-class sensitivity and the model
   * catalog (`task_classes`/`models` have no firm_id). On the supported single-firm appliance
   * (bootstrap-firm provisions exactly one firm) a firm admin IS the operator, so these run
   * unchanged. If a second firm is ever provisioned, a firm admin mutating global state would
   * silently affect the other firm — most critically task-class SENSITIVITY, the data
   * boundary — so refuse (Q-079). Cross-firm tampering fails closed rather than latent.
   */
  const assertSoleFirm = async (session: SessionData, reply: FastifyReply): Promise<boolean> => {
    const firmRows = await db.query.firms.findMany({ columns: { id: true } });
    if (firmRows.length > 1) {
      void reply
        .code(403)
        .send(
          errorBody(
            new RouterError(
              'policy_blocked',
              'suite-wide catalog/sensitivity changes are operator-only on a multi-firm deployment',
            ),
          ),
        );
      return false;
    }
    void session;
    return true;
  };

  // ── auth ───────────────────────────────────────────────────────────────────
  app.post('/admin-api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return fail(reply, new RouterError('invalid_request', 'email + password required'));
    const user = await db.query.users.findFirst({ where: eq(users.email, body.data.email) });
    // Always perform password work, even for an unknown email (QA-D finding #3): returning
    // early made "no such user" ~17× faster than a wrong password — a user-enumeration oracle.
    const hash = user?.passwordHash ?? (await dummyPasswordHash());
    const passwordOk = await verifyPassword(body.data.password, hash);
    if (!user?.passwordHash || !passwordOk) {
      return fail(reply, new RouterError('auth_error', 'invalid credentials'));
    }
    const cookie = opts.sessions.create({
      userId: user.id,
      firmId: user.firmId,
      email: user.email ?? '',
      role: user.role,
    });
    setSessionCookie(reply, cookie, opts.secureCookies);
    return reply.send({ email: user.email, role: user.role, displayName: user.displayName });
  });

  app.post('/admin-api/auth/logout', (req, reply) => {
    opts.sessions.destroy(parseCookies(req)[SESSION_COOKIE]);
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get('/admin-api/auth/me', async (req, reply) => {
    const session = sessionOf(req);
    if (!session) return fail(reply, new RouterError('auth_error', 'not logged in'));
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, session.firmId) });
    return reply.send({ email: session.email, role: session.role, firm: firm?.name });
  });

  // ── providers (11.3 backend) ────────────────────────────────────────────────
  app.get('/admin-api/providers', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const rows = await db.query.providers.findMany({
      where: (p, { and: and_, eq: eq_, isNull }) =>
        and_(eq_(p.firmId, session.firmId), isNull(p.deletedAt)),
      orderBy: providers.createdAt,
    });
    const withCreds = await Promise.all(
      rows.map(async (p) => ({
        ...p,
        credentials: opts.vault ? await opts.vault.list(p.id) : [],
      })),
    );
    return reply.send(withCreds);
  });

  const providerBody = z.object({
    kind: z.enum(PROVIDER_KINDS),
    label: z.string().min(1).max(120),
    baseUrl: z.string().url(),
    authType: z.enum(['api_key', 'none']).default('api_key'),
    modelMapping: z.record(z.string()).default({}),
  });

  app.post('/admin-api/providers', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const body = providerBody.safeParse(req.body);
    if (!body.success)
      return fail(reply, new RouterError('invalid_request', body.error.issues[0]?.message ?? 'bad body'));
    // SSRF config-time gate (14.2): pattern + DNS resolution
    const verdict = await checkBaseUrlWithDns(body.data.kind, body.data.baseUrl);
    if (!verdict.ok) return fail(reply, new RouterError('invalid_request', `base_url rejected: ${verdict.reason}`));
    const [row] = await db
      .insert(providers)
      .values({ firmId: session.firmId, ...body.data })
      .returning();
    auditConfig(session, 'provider', row!.id, 'create', {
      kind: body.data.kind,
      label: body.data.label,
      baseUrl: body.data.baseUrl,
    });
    return reply.code(201).send(row);
  });

  app.patch('/admin-api/providers/:id', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = providerBody.partial().safeParse(req.body);
    if (!params.success || !body.success)
      return fail(reply, new RouterError('invalid_request', 'bad request'));
    if (Object.keys(body.data).length === 0)
      return fail(reply, new RouterError('invalid_request', 'empty update'));
    const before = await db.query.providers.findFirst({ where: eq(providers.id, params.data.id) });
    if (!before || before.deletedAt || before.firmId !== session.firmId)
      return fail(reply, new RouterError('invalid_request', 'provider not found'));
    if (body.data.baseUrl || body.data.kind) {
      const verdict = await checkBaseUrlWithDns(body.data.kind ?? before.kind, body.data.baseUrl ?? before.baseUrl);
      if (!verdict.ok)
        return fail(reply, new RouterError('invalid_request', `base_url rejected: ${verdict.reason}`));
    }
    const [row] = await db.update(providers).set(body.data).where(eq(providers.id, params.data.id)).returning();
    auditConfig(
      session,
      'provider',
      params.data.id,
      'update',
      { label: row!.label, baseUrl: row!.baseUrl },
      { label: before.label, baseUrl: before.baseUrl },
    );
    return reply.send(row);
  });

  app.delete('/admin-api/providers/:id', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return fail(reply, new RouterError('invalid_request', 'bad id'));
    const target = await db.query.providers.findFirst({ where: eq(providers.id, params.data.id) });
    if (!target || target.firmId !== session.firmId)
      return fail(reply, new RouterError('invalid_request', 'provider not found'));
    await db.update(providers).set({ deletedAt: new Date() }).where(eq(providers.id, params.data.id));
    // credential lifecycle: a deleted provider must not keep decryptable ACTIVE secrets
    await db
      .update(providerCredentials)
      .set({ status: 'revoked' })
      .where(eq(providerCredentials.providerId, params.data.id));
    auditConfig(session, 'provider', params.data.id, 'delete');
    return reply.send({ ok: true });
  });

  app.post('/admin-api/providers/:id/test', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ model: z.string().optional() }).safeParse(req.body ?? {});
    if (!params.success || !body.success) return fail(reply, new RouterError('invalid_request', 'bad request'));
    const provider = await db.query.providers.findFirst({ where: eq(providers.id, params.data.id) });
    if (!provider || provider.deletedAt || provider.firmId !== session.firmId)
      return fail(reply, new RouterError('invalid_request', 'provider not found'));
    const adapter = opts.adapterFor(provider.kind);
    if (!adapter) return fail(reply, new RouterError('invalid_request', 'no adapter'));
    try {
      if (provider.authType === 'none') {
        const result = await adapter.testConnection(
          {
            providerId: provider.id,
            model: body.data.model ?? '',
            baseUrl: provider.baseUrl,
          },
          AbortSignal.timeout(20_000),
        );
        await db
          .update(providers)
          .set({ status: result.ok ? 'healthy' : 'down', lastHealthAt: new Date(), health: { lastTest: result } })
          .where(eq(providers.id, provider.id));
        return await reply.send(result);
      }
      if (!opts.vault) return fail(reply, new RouterError('unknown', 'vault unavailable (MASTER_KEY unset)'));
      return await reply.send(
        await opts.vault.test(provider.id, adapter, body.data.model ? { model: body.data.model } : {}),
      );
    } catch (err) {
      return fail(reply, err);
    }
  });

  // credentials (write-only, 11.1)
  app.post('/admin-api/providers/:id/credentials', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    if (!opts.vault) return fail(reply, new RouterError('unknown', 'vault unavailable (MASTER_KEY unset)'));
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ apiKey: z.string().min(8) }).safeParse(req.body);
    if (!params.success || !body.success) return fail(reply, new RouterError('invalid_request', 'bad request'));
    const owner = await db.query.providers.findFirst({ where: eq(providers.id, params.data.id) });
    if (!owner || owner.firmId !== session.firmId)
      return fail(reply, new RouterError('invalid_request', 'provider not found'));
    try {
      return await reply.code(201).send(await opts.vault.add(params.data.id, body.data.apiKey, session.userId));
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** credential :id → owning provider must belong to the session's firm (multi-firm hygiene) */
  const credentialInFirm = async (credentialId: string, firmId: string): Promise<boolean> => {
    const cred = await db.query.providerCredentials.findFirst({
      where: eq(providerCredentials.id, credentialId),
    });
    if (!cred) return false;
    const owner = await db.query.providers.findFirst({ where: eq(providers.id, cred.providerId) });
    return owner?.firmId === firmId;
  };

  app.post('/admin-api/credentials/:id/promote', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    if (!opts.vault) return fail(reply, new RouterError('unknown', 'vault unavailable'));
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return fail(reply, new RouterError('invalid_request', 'bad id'));
    if (!(await credentialInFirm(params.data.id, session.firmId)))
      return fail(reply, new RouterError('invalid_request', 'credential not found'));
    try {
      return await reply.send(await opts.vault.promote(params.data.id));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/admin-api/credentials/:id/revoke', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    if (!opts.vault) return fail(reply, new RouterError('unknown', 'vault unavailable'));
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return fail(reply, new RouterError('invalid_request', 'bad id'));
    if (!(await credentialInFirm(params.data.id, session.firmId)))
      return fail(reply, new RouterError('invalid_request', 'credential not found'));
    try {
      await opts.vault.revoke(params.data.id);
      return await reply.send({ ok: true });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── catalog (11.4 backend) ─────────────────────────────────────────────────
  app.get('/admin-api/models', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const q = z
      .object({ search: safeString(120).optional(), status: safeString(20).optional() })
      .safeParse(req.query);
    const rows = await db.query.models.findMany({ orderBy: models.canonicalId });
    const search = q.success ? q.data.search?.toLowerCase() : undefined;
    const status = q.success ? q.data.status : undefined;
    const filtered = rows.filter(
      (m) =>
        (!search || m.canonicalId.toLowerCase().includes(search) || m.displayName.toLowerCase().includes(search)) &&
        (!status || m.status === status),
    );
    // latest pricing per model for $/MTok display
    const pricing = await db.query.modelPricing.findMany({
      orderBy: (p, { desc }) => desc(p.effectiveFrom),
    });
    const latestByModel = new Map<string, (typeof pricing)[number]>();
    for (const p of pricing) if (!latestByModel.has(p.modelId)) latestByModel.set(p.modelId, p);
    return reply.send(
      filtered.map((m) => ({
        ...m,
        effective: effectiveCapabilities(m),
        pricing: latestByModel.get(m.id) ?? null,
      })),
    );
  });

  app.post('/admin-api/models', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    if (!(await assertSoleFirm(session, reply))) return reply;
    try {
      const row = await createCustomModel(db, req.body);
      auditConfig(session, 'model', row.id, 'create', { canonicalId: row.canonicalId });
      return await reply.code(201).send(row);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch('/admin-api/models/:id/overrides', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return fail(reply, new RouterError('invalid_request', 'bad id'));
    if (!(await assertSoleFirm(session, reply))) return reply;
    try {
      await setCapabilityOverrides(db, params.data.id, req.body);
      opts.deps.engine.invalidate();
      auditConfig(session, 'model', params.data.id, 'update', { overrides: JSON.stringify(req.body) });
      return await reply.send({ ok: true });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/admin-api/models/:id/retire', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return fail(reply, new RouterError('invalid_request', 'bad id'));
    if (!(await assertSoleFirm(session, reply))) return reply;
    try {
      const outcome = await retireCustomModel(db, params.data.id);
      auditConfig(session, 'model', params.data.id, 'delete', { outcome });
      return await reply.send({ outcome });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── task classes + policies (11.5 backend) ─────────────────────────────────
  app.get('/admin-api/task-classes', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return reply.send(await db.query.taskClasses.findMany({ orderBy: taskClasses.key }));
  });

  app.patch('/admin-api/task-classes/:key', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const params = z.object({ key: z.string() }).safeParse(req.params);
    const body = z
      .object({
        sensitivity: z.enum(['local_only', 'cloud_deidentified', 'cloud_allowed']).optional(),
        description: z.string().max(500).optional(),
        defaultMaxTokens: z.number().int().positive().optional(),
      })
      .safeParse(req.body);
    if (!params.success || !body.success) return fail(reply, new RouterError('invalid_request', 'bad request'));
    // task_classes is global — sensitivity is the data boundary, so a multi-firm deployment
    // must not let one firm's admin widen it for another (Q-079)
    if (!(await assertSoleFirm(session, reply))) return reply;
    const before = await db.query.taskClasses.findFirst({ where: eq(taskClasses.key, params.data.key) });
    if (!before) return fail(reply, new RouterError('invalid_request', 'unknown task class'));
    await db.update(taskClasses).set(body.data).where(eq(taskClasses.id, before.id));
    opts.deps.engine.invalidate();
    // sensitivity changes are THE deliberate widening path — always audited with before/after
    auditConfig(
      session,
      'task_class',
      before.key,
      'update',
      { sensitivity: body.data.sensitivity ?? before.sensitivity },
      { sensitivity: before.sensitivity },
    );
    return reply.send({ ok: true });
  });

  app.get('/admin-api/policies', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    return reply.send(await exportPolicies(db, session.firmId));
  });

  app.put('/admin-api/policies/:taskClassKey', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const params = z.object({ taskClassKey: z.string() }).safeParse(req.params);
    const body = z
      .object({
        defaultModel: z.string(),
        allowedModels: z.array(z.string()).default([]),
        fallbackChain: z.array(z.string()).default([]),
        maxTokensOverride: z.number().int().positive().nullable().optional(),
        temperatureMin: z.number().nullable().optional(),
        temperatureMax: z.number().nullable().optional(),
        monthlyBudgetCents: z.number().int().nullable().optional(),
        enabled: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!params.success || !body.success)
      return fail(reply, new RouterError('invalid_request', body.success ? 'bad key' : 'bad body'));
    try {
      const id = await savePolicy(db, opts.deps.engine, {
        firmId: session.firmId,
        taskClassKey: params.data.taskClassKey,
        defaultModelCanonicalId: body.data.defaultModel,
        allowedModelCanonicalIds: body.data.allowedModels,
        fallbackChainCanonicalIds: body.data.fallbackChain,
        maxTokensOverride: body.data.maxTokensOverride ?? null,
        temperatureMin: body.data.temperatureMin ?? null,
        temperatureMax: body.data.temperatureMax ?? null,
        monthlyBudgetCents: body.data.monthlyBudgetCents ?? null,
        enabled: body.data.enabled ?? true,
      });
      return await reply.send({ id });
    } catch (err) {
      return fail(reply, err); // config-time gating errors carry the specific capability gap
    }
  });

  app.post('/admin-api/policies/import', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    try {
      return await reply.send(await importPolicies(db, opts.deps.engine, session.firmId, req.body));
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── firm settings (11.6) ───────────────────────────────────────────────────
  app.get('/admin-api/settings', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, session.firmId) });
    return reply.send({ name: firm?.name, settings: firm?.settings ?? {} });
  });

  const settingsSchema = z
    .object({
      scrubber_mode: z.enum(['block', 'redact', 'warn']).optional(),
      banned_provider_kinds: z.array(z.enum(PROVIDER_KINDS)).optional(),
      banned_model_patterns: z.array(z.string().max(200)).max(50).optional(),
      // null = explicit clear — merge semantics keep omitted keys, so without a null
      // convention a cap could never be removed from the console (Q-073)
      global_temperature_max: z.number().min(0).max(2).nullable().optional(),
      budgets: z
        .object({
          firm_monthly_cents: z.number().int().positive().optional(),
          apps: z.record(z.number().int().positive()).optional(),
          users: z.record(z.number().int().positive()).optional(),
          soft_pct: z.number().int().min(1).max(100).optional(),
        })
        .optional(),
    })
    .strict();

  app.put('/admin-api/settings', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const body = settingsSchema.safeParse(req.body);
    if (!body.success)
      return fail(reply, new RouterError('invalid_request', body.error.issues[0]?.message ?? 'bad settings'));
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, session.firmId) });
    const merged: Record<string, unknown> = { ...((firm?.settings ?? {}) as Record<string, unknown>), ...body.data };
    for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k]; // null = clear
    await db.update(firms).set({ settings: merged }).where(eq(firms.id, session.firmId));
    opts.deps.engine.invalidate(session.firmId);
    auditConfig(session, 'firm_settings', session.firmId, 'update', {
      scrubber_mode: body.data.scrubber_mode ?? null,
      changed: Object.keys(body.data).join(','),
    });
    return reply.send({ settings: merged });
  });

  // ── dashboards (11.7) + live log (11.8) ────────────────────────────────────
  app.get('/admin-api/dashboard/spend', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const q = z
      .object({
        by: z.enum(['day', 'model', 'app', 'task_class', 'client']).default('day'),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      })
      .safeParse(req.query);
    if (!q.success) return fail(reply, new RouterError('invalid_request', 'bad query'));
    const filter = {
      firmId: session.firmId,
      ...(q.data.from ? { from: q.data.from } : {}),
      ...(q.data.to ? { to: q.data.to } : {}),
    };
    const [spend, latency] = await Promise.all([spendBy(db, q.data.by, filter), latencyStats(db, filter)]);
    return reply.send({ by: q.data.by, spend, latency });
  });

  app.get('/admin-api/dashboard/health', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const providerRows = await db.query.providers.findMany({
      where: (p, { isNull }) => isNull(p.deletedAt),
    });
    // firm-scoped: scope_ref keys are firmId or firmId-prefixed (Q-073)
    const budgets = (
      await db.query.budgetsState.findMany({
        where: (b, { eq: eq_ }) => eq_(b.period, currentPeriod()),
      })
    ).filter((b) => b.scopeRef === session.firmId || b.scopeRef.startsWith(`${session.firmId}:`));
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, session.firmId) });
    return reply.send({
      providers: providerRows.map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        status: p.status,
        lastHealthAt: p.lastHealthAt,
        health: p.health,
      })),
      breakers: opts.breakerSnapshot?.() ?? [],
      budgets: { period: currentPeriod(), state: budgets, settings: (firm?.settings as { budgets?: unknown })?.budgets ?? {} },
      zeroCloud: providerRows.every((p) => isLocalKind(p.kind)),
    });
  });

  app.get('/admin-api/audit', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const q = z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        event: safeString(80).optional(),
        app: safeString(80).optional(),
        limit: z.coerce.number().int().positive().max(1000).optional(),
      })
      .safeParse(req.query);
    if (!q.success) return fail(reply, new RouterError('invalid_request', 'bad query'));
    return reply.send(
      await queryAudit(db, {
        firmId: session.firmId,
        ...(q.data.from ? { from: q.data.from } : {}),
        ...(q.data.to ? { to: q.data.to } : {}),
        ...(q.data.event ? { event: q.data.event } : {}),
        ...(q.data.app ? { app: q.data.app } : {}),
        limit: q.data.limit ?? 100,
      }),
    );
  });

  app.get('/admin-api/audit.csv', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const rows = await queryAudit(db, { firmId: session.firmId, limit: 5000 });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="audit.csv"')
      .send(auditToCsv(rows));
  });

  app.get('/admin-api/ledger.csv', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const rows = await ledgerRows(db, { firmId: session.firmId });
    const cols = [
      'ts', 'requestId', 'app', 'modelServed', 'promptTokens', 'completionTokens', 'cachedReadTokens',
      'costCents', 'costUnknown', 'latencyMs', 'status', 'clientRef', 'engagementRef',
    ];
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="ledger.csv"')
      .send(rowsToCsv(rows, cols));
  });

  // ── WISP AI Data-Handling Appendix (14.7 compliance export) ─────────────────
  app.get('/admin-api/wisp.docx', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const data = await buildWispData(db, session.firmId, opts.retentionDays);
    const buf = await renderWispDocx(data);
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .header('content-disposition', 'attachment; filename="AI-Data-Handling-Appendix.docx"')
      .send(buf);
  });

  // ── app tokens (12.7 surface, admin-managed) ───────────────────────────────
  app.get('/admin-api/app-tokens', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const rows = await db.query.appTokens.findMany({
      where: eq(appTokens.firmId, session.firmId),
      orderBy: appTokens.createdAt,
    });
    return reply.send(
      rows.map((t) => ({
        id: t.id,
        app: t.app,
        scopes: t.scopes,
        lastUsedAt: t.lastUsedAt,
        revokedAt: t.revokedAt,
        createdAt: t.createdAt,
      })),
    );
  });

  app.post('/admin-api/app-tokens', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const body = z.object({ app: z.string().min(1).max(60) }).safeParse(req.body);
    if (!body.success) return fail(reply, new RouterError('invalid_request', 'app required'));
    const plaintext = `vibe-${body.data.app}-${randomBytes(24).toString('base64url')}`;
    const [row] = await db
      .insert(appTokens)
      .values({
        firmId: session.firmId,
        app: body.data.app,
        tokenHash: createHash('sha256').update(plaintext).digest('hex'),
        scopes: ['chat'],
      })
      .returning();
    auditConfig(session, 'app_token', row!.id, 'create', { app: body.data.app });
    // plaintext shown exactly once
    return reply.code(201).send({ id: row!.id, app: body.data.app, token: plaintext });
  });

  app.post('/admin-api/app-tokens/:id/revoke', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return fail(reply, new RouterError('invalid_request', 'bad id'));
    const token = await db.query.appTokens.findFirst({ where: eq(appTokens.id, params.data.id) });
    if (!token || token.firmId !== session.firmId)
      return fail(reply, new RouterError('invalid_request', 'token not found'));
    await db.update(appTokens).set({ revokedAt: new Date() }).where(eq(appTokens.id, params.data.id));
    auditConfig(session, 'app_token', params.data.id, 'delete');
    return reply.send({ ok: true });
  });

  // ── test prompt (11.10 smoke path: wizard → policy → live request → ledger) ─
  app.post('/admin-api/test-prompt', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return reply;
    const body = z
      .object({ taskClass: z.string(), content: z.string().min(1).max(4000) })
      .safeParse(req.body);
    if (!body.success) return fail(reply, new RouterError('invalid_request', 'taskClass + content required'));

    const envelope = toEnvelope(
      { messages: [{ role: 'user', content: body.data.content }] },
      body.data.taskClass,
      { app: 'admin-ui' },
      { maxMessages: 10, maxJsonDepth: 10 },
    );
    const ctx = newPipelineCtx(envelope);
    // trusted server-side context: the admin session IS the authorization
    ctx.auth = { firmId: session.firmId, app: 'admin-ui', scopes: ['chat'], tokenId: session.userId };
    const abort = new AbortController();
    try {
      await stageResolveTaskClass(ctx, opts.deps);
      await stagePolicy(ctx, opts.deps);
      await stageBudget(ctx, opts.deps);
      await stageScrub(ctx, opts.deps);
      await stageRoute(ctx, opts.deps);
      await stageAdapt(ctx, opts.deps, abort.signal);
      await opts.deps.ledger.write(ctx);
      emitTerminalAudit(ctx, opts.deps);
      return await reply.send({
        requestId: ctx.requestId,
        model: ctx.response?.served.model,
        content: ctx.response?.message.content.slice(0, 2000),
        usage: ctx.response?.usage,
        latencyMs: ctx.response?.served.latencyMs,
      });
    } catch (err) {
      ctx.error = toRouterError(err);
      await opts.deps.ledger.write(ctx).catch(() => {});
      emitTerminalAudit(ctx, opts.deps);
      return fail(reply, err);
    }
  });
}
