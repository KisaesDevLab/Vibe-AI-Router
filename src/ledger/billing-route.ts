/**
 * T&B billing feed surface (9.9) — read-only, app-token authenticated.
 * GET /v1/billing/usage?period=yyyymm[&client_ref=…]
 * POST /v1/budget/precheck — AN-2 (Q-093): "can I afford this batch?"
 * before uploading work; never throws budget_exceeded, returns structure.
 *
 * Both routes share the pipeline's per-app-token rate limiter when wired
 * (review finding: precheck is built for programmatic use and costs DB
 * aggregates — it must not be an unthrottled hot path). Precheck resolves
 * the task class through PolicyEngine so its answer matches what the chat
 * pipeline will actually enforce — a firm without an enabled policy gets
 * policy_blocked here, not a false ok:true.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { RateLimiter } from '../resilience/limiter.js';
import { authenticateAppToken } from '../gateway/pipeline.js';
import { RouterError, errorBody, toRouterError } from '../gateway/errors.js';
import { billingUsage } from './aggregate.js';
import { checkBudgets, type BudgetSettings } from './budget.js';

const querySchema = z.object({
  period: z.string().regex(/^\d{6}$/),
  client_ref: z.string().optional(),
});

const precheckSchema = z
  .object({
    task_class: z.string().min(1).max(120),
    user_id: z.string().max(200).optional(),
  })
  .strict();

export interface BillingFeedDeps {
  db: Db;
  engine: PolicyEngine;
  rateLimits?: { perToken: RateLimiter };
}

export function registerBillingFeed(app: FastifyInstance, deps: BillingFeedDeps): void {
  /** app-token auth + the same per-token limiter the chat pipeline uses (10.6) */
  const authenticate = async (
    authHeader: string | undefined,
  ): Promise<Awaited<ReturnType<typeof authenticateAppToken>>> => {
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    const auth = await authenticateAppToken(deps.db, bearer);
    const wait = deps.rateLimits?.perToken.take(`t:${auth.tokenId}`);
    if (wait !== undefined && wait > 0) {
      throw new RouterError('rate_limited', 'rate limit exceeded', { retryAfterSeconds: wait });
    }
    return auth;
  };

  app.get('/v1/billing/usage', async (req, reply) => {
    try {
      const auth = await authenticate(req.headers.authorization);
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new RouterError('invalid_request', 'period=yyyymm required');
      }
      const items = await billingUsage(deps.db, auth.firmId, parsed.data.period, parsed.data.client_ref);
      return await reply.send({ period: parsed.data.period, items });
    } catch (err) {
      const rerr = toRouterError(err);
      return reply.code(rerr.status).send(errorBody(rerr));
    }
  });

  app.post('/v1/budget/precheck', async (req, reply) => {
    try {
      const auth = await authenticate(req.headers.authorization);
      const parsed = precheckSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RouterError('invalid_request', 'task_class required');
      }
      // The same (cached) resolution the chat pipeline runs — throws
      // policy_blocked for an unknown class or a missing/disabled policy,
      // so ok:true genuinely means "a request would pass the policy gate".
      const firmSettings = await deps.engine.firmSettings(auth.firmId);
      const effective = await deps.engine.resolve(auth.firmId, parsed.data.task_class, firmSettings);
      const settings = (firmSettings as { budgets?: BudgetSettings }).budgets ?? {};
      try {
        const result = await checkBudgets(deps.db, {
          firmId: auth.firmId,
          app: auth.app,
          ...(parsed.data.user_id ? { userId: parsed.data.user_id } : {}),
          taskClassId: effective.taskClass.id,
          settings,
          policyMonthlyCents: effective.policy.monthlyBudgetCents,
        });
        return await reply.send({
          ok: true,
          soft_warnings: result.softWarnings.map((w) => ({
            scope: w.scope,
            limit_cents: w.limitCents,
            spent_cents: w.spentCents,
          })),
        });
      } catch (err) {
        // A precheck never fails on an exhausted budget — it reports it.
        if (err instanceof RouterError && err.code === 'budget_exceeded') {
          return await reply.send({
            ok: false,
            reason: 'budget_exceeded',
            ...(err.detail ?? {}),
          });
        }
        throw err;
      }
    } catch (err) {
      const rerr = toRouterError(err);
      return reply.code(rerr.status).send(errorBody(rerr));
    }
  });
}
