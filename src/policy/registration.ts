/**
 * App task-class registration (7.1): apps declare their classes + requirements at startup.
 * Idempotent upsert, version-stamped. SECURITY: a NEW class is always created local_only
 * regardless of what the app suggests, unless it appears in the curated default pack; an
 * EXISTING class's sensitivity is never changed by registration (SENSITIVITY-REVIEW.md).
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { taskClasses } from '../../db/schema.js';
import { RouterError, errorBody, toRouterError } from '../gateway/errors.js';
import { authenticateAppToken } from '../gateway/pipeline.js';
import { DEFAULT_PACK } from './pack.js';
import type { PolicyEngine } from './engine.js';

const registrationSchema = z.object({
  app: z.string().min(1),
  version: z.string().min(1),
  classes: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
        description: z.string().max(500).default(''),
        requires: z
          .object({
            tools: z.boolean().optional(),
            json_schema: z.boolean().optional(),
            vision: z.boolean().optional(),
            caching: z.boolean().optional(),
            thinking_budget: z.number().int().positive().optional(),
          })
          .strict()
          .default({}),
        defaultMaxTokens: z.number().int().positive().max(200_000).default(1024),
      }),
    )
    .min(1)
    .max(50),
});

export function registerTaskClassRegistration(
  app: FastifyInstance,
  deps: { db: Db; engine: PolicyEngine },
): void {
  app.post('/v1/task-classes/register', async (req, reply) => {
    try {
      const authHeader = req.headers.authorization;
      const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
      const auth = await authenticateAppToken(deps.db, bearer);

      const parsed = registrationSchema.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new RouterError(
          'invalid_request',
          `invalid registration: ${issue?.path.join('.')}: ${issue?.message}`,
        );
      }
      const body = parsed.data;
      if (body.app !== auth.app) {
        throw new RouterError('auth_error', `token is for app ${auth.app}, not ${body.app}`);
      }

      const results: { key: string; created: boolean; sensitivity: string }[] = [];
      for (const cls of body.classes) {
        const existing = await deps.db.query.taskClasses.findFirst({
          where: eq(taskClasses.key, cls.key),
        });
        if (existing) {
          // requirements/description may evolve with app versions; sensitivity NEVER moves here
          await deps.db
            .update(taskClasses)
            .set({
              description: cls.description || existing.description,
              requires: cls.requires,
              defaultMaxTokens: cls.defaultMaxTokens,
              registeredByAppVersion: `${body.app}@${body.version}`,
            })
            .where(eq(taskClasses.id, existing.id));
          results.push({ key: cls.key, created: false, sensitivity: existing.sensitivity });
        } else {
          const packEntry = DEFAULT_PACK.find((p) => p.key === cls.key);
          const sensitivity = packEntry?.sensitivity ?? 'local_only'; // most restrictive default
          await deps.db.insert(taskClasses).values({
            key: cls.key,
            app: body.app,
            description: cls.description,
            sensitivity,
            requires: cls.requires,
            defaultMaxTokens: cls.defaultMaxTokens,
            registeredByAppVersion: `${body.app}@${body.version}`,
          });
          results.push({ key: cls.key, created: true, sensitivity });
        }
      }
      deps.engine.invalidate(auth.firmId);
      return await reply.send({ registered: results });
    } catch (err) {
      const rerr = toRouterError(err);
      return reply.code(rerr.status).send(errorBody(rerr));
    }
  });
}
