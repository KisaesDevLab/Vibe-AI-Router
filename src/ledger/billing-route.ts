/**
 * T&B billing feed surface (9.9) — read-only, app-token authenticated.
 * GET /v1/billing/usage?period=yyyymm[&client_ref=…]
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { authenticateAppToken } from '../gateway/pipeline.js';
import { RouterError, errorBody, toRouterError } from '../gateway/errors.js';
import { billingUsage } from './aggregate.js';

const querySchema = z.object({
  period: z.string().regex(/^\d{6}$/),
  client_ref: z.string().optional(),
});

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
}
