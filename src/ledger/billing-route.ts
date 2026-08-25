/**
 * T&B billing feed surface (9.9) — read-only, app-token authenticated.
 * GET /v1/billing/usage?period=yyyymm[&client_ref=…]
 * POST /v1/budget/precheck — AN-2 (Q-093): "can I afford this batch?"
 * before uploading work; never throws budget_exceeded, returns structure.
 */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { firms, policies, taskClasses } from '../../db/schema.js';
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

export function registerBillingFeed(app: FastifyInstance, deps: { db: Db }): void {
  app.get('/v1/billing/usage', async (req, reply) => {
    try {
      const authHeader = req.headers.authorization;
      const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
      const auth = await authenticateAppToken(deps.db, bearer);
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
      const authHeader = req.headers.authorization;
      const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
      const auth = await authenticateAppToken(deps.db, bearer);
      const parsed = precheckSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RouterError('invalid_request', 'task_class required');
      }
      const tc = await deps.db.query.taskClasses.findFirst({
        where: eq(taskClasses.key, parsed.data.task_class),
      });
      if (!tc) throw new RouterError('policy_blocked', `unknown task class: ${parsed.data.task_class}`);
      const policy = await deps.db.query.policies.findFirst({
        where: and(eq(policies.firmId, auth.firmId), eq(policies.taskClassId, tc.id)),
      });
      const firm = await deps.db.query.firms.findFirst({ where: eq(firms.id, auth.firmId) });
      const settings =
        ((firm?.settings ?? {}) as { budgets?: BudgetSettings }).budgets ?? {};
      try {
        const result = await checkBudgets(deps.db, {
          firmId: auth.firmId,
          app: auth.app,
          ...(parsed.data.user_id ? { userId: parsed.data.user_id } : {}),
          taskClassId: tc.id,
          settings,
          policyMonthlyCents: policy?.monthlyBudgetCents ?? null,
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
