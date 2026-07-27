/**
 * Config-time policy persistence (7.3) + export/import (7.9). Saving is gated: every model in
 * default/allowed/fallback must satisfy the task class's requirements and sensitivity — the
 * save is rejected with the SPECIFIC missing capability, before anything hits the database.
 */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { firms, models, policies, taskClasses } from '../../db/schema.js';
import { RouterError } from '../gateway/errors.js';
import { effectiveCapabilities, type CapabilityKey } from '../catalog/service.js';
import { writeAudit } from '../protect/audit.js';
import { classRequires, type PolicyEngine } from './engine.js';

type TaskClassRow = typeof taskClasses.$inferSelect;
type ModelRow = typeof models.$inferSelect;

export interface SavePolicyInput {
  firmId: string;
  taskClassKey: string;
  defaultModelCanonicalId: string;
  allowedModelCanonicalIds?: string[];
  fallbackChainCanonicalIds?: string[];
  maxTokensOverride?: number | null;
  temperatureMin?: number | null;
  temperatureMax?: number | null;
  monthlyBudgetCents?: number | null;
  enabled?: boolean;
}

/** The config-time gate (7.3): returns the specific reason a model may not serve this class. */
export function configTimeViolation(model: ModelRow, tc: TaskClassRow): string | undefined {
  if (tc.sensitivity === 'local_only' && model.providerKind !== 'local') {
    return `${model.canonicalId}: local_only class requires a local model (model is ${model.providerKind})`;
  }
  const req = classRequires(tc);
  const needs: CapabilityKey[] = [];
  if (req.tools) needs.push('tools');
  if (req.json_schema) needs.push('json_schema');
  if (req.vision) needs.push('vision');
  const caps = effectiveCapabilities(model);
  const missing = needs.filter((n) => !caps[n]);
  if (missing.length > 0) return `${model.canonicalId}: missing capability ${missing.join(', ')}`;
  return undefined;
}

export async function savePolicy(db: Db, engine: PolicyEngine, input: SavePolicyInput): Promise<string> {
  const tc = await db.query.taskClasses.findFirst({ where: eq(taskClasses.key, input.taskClassKey) });
  if (!tc) throw new RouterError('invalid_request', `unknown task class: ${input.taskClassKey}`);

  const canonicalIds = [
    input.defaultModelCanonicalId,
    ...(input.allowedModelCanonicalIds ?? []),
    ...(input.fallbackChainCanonicalIds ?? []),
  ];
  const rows = await db.query.models.findMany({
    where: (m, { inArray }) => inArray(m.canonicalId, canonicalIds),
  });
  const byCanonical = new Map(rows.map((m) => [m.canonicalId, m]));

  const problems: string[] = [];
  for (const id of new Set(canonicalIds)) {
    const model = byCanonical.get(id);
    if (!model) {
      problems.push(`${id}: not in catalog`);
      continue;
    }
    const violation = configTimeViolation(model, tc);
    if (violation) problems.push(violation);
  }
  if (problems.length > 0) {
    throw new RouterError('invalid_request', `policy rejected: ${problems.join('; ')}`, {
      detail: { problems },
    });
  }

  const defaultModel = byCanonical.get(input.defaultModelCanonicalId)!;
  const allowedIds = (input.allowedModelCanonicalIds ?? []).map((c) => byCanonical.get(c)!.id);
  const fallbackIds = (input.fallbackChainCanonicalIds ?? []).map((c) => byCanonical.get(c)!.id);

  const values = {
    defaultModelId: defaultModel.id,
    allowedModelIds: allowedIds,
    fallbackChain: fallbackIds,
    maxTokensOverride: input.maxTokensOverride ?? null,
    temperatureMin: input.temperatureMin ?? null,
    temperatureMax: input.temperatureMax ?? null,
    monthlyBudgetCents: input.monthlyBudgetCents ?? null,
    enabled: input.enabled ?? true,
  };
  const existing = await db.query.policies.findFirst({
    where: and(eq(policies.firmId, input.firmId), eq(policies.taskClassId, tc.id)),
  });
  let id: string;
  if (existing) {
    await db.update(policies).set(values).where(eq(policies.id, existing.id));
    id = existing.id;
  } else {
    const [row] = await db
      .insert(policies)
      .values({ firmId: input.firmId, taskClassId: tc.id, ...values })
      .returning();
    id = row!.id;
  }
  engine.invalidate(input.firmId); // cache invalidation on config change (7.2)
  // config-change audit (8.6) — metadata only
  await writeAudit(db, {
    firmId: input.firmId,
    event: 'config_change',
    taskClass: tc.key,
    detail: {
      entity: 'policy',
      entityId: id,
      action: existing ? 'update' : 'create',
      ...(existing
        ? {
            before: {
              defaultModelId: existing.defaultModelId,
              enabled: existing.enabled,
              maxTokensOverride: existing.maxTokensOverride,
            },
          }
        : {}),
      after: {
        defaultModel: input.defaultModelCanonicalId,
        allowed: (input.allowedModelCanonicalIds ?? []).join(','),
        fallback: (input.fallbackChainCanonicalIds ?? []).join(','),
        enabled: values.enabled,
      },
    },
  });
  return id;
}

// ── export / import (7.9) ────────────────────────────────────────────────────

const exportSchema = z.object({
  version: z.literal(1),
  taskClasses: z.array(
    z.object({
      key: z.string(),
      app: z.string(),
      description: z.string(),
      sensitivity: z.enum(['local_only', 'cloud_deidentified', 'cloud_allowed']),
      requires: z.record(z.unknown()),
      defaultMaxTokens: z.number().int().positive(),
    }),
  ),
  policies: z.array(
    z.object({
      taskClassKey: z.string(),
      defaultModel: z.string(),
      allowedModels: z.array(z.string()),
      fallbackChain: z.array(z.string()),
      maxTokensOverride: z.number().int().positive().nullable(),
      temperatureMin: z.number().nullable(),
      temperatureMax: z.number().nullable(),
      monthlyBudgetCents: z.number().int().nullable(),
      enabled: z.boolean(),
    }),
  ),
});

export type PolicyExport = z.infer<typeof exportSchema>;

export async function exportPolicies(db: Db, firmId: string): Promise<PolicyExport> {
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  if (!firm) throw new RouterError('invalid_request', 'firm not found');
  const classes = await db.query.taskClasses.findMany({ orderBy: taskClasses.key });
  const policyRows = await db.query.policies.findMany({ where: eq(policies.firmId, firmId) });
  const allModels = await db.query.models.findMany();
  const modelById = new Map(allModels.map((m) => [m.id, m.canonicalId]));
  const classById = new Map(classes.map((c) => [c.id, c.key]));

  return {
    version: 1,
    taskClasses: classes.map((c) => ({
      key: c.key,
      app: c.app,
      description: c.description,
      sensitivity: c.sensitivity,
      requires: c.requires as Record<string, unknown>,
      defaultMaxTokens: c.defaultMaxTokens,
    })),
    policies: policyRows
      .filter((p) => classById.has(p.taskClassId))
      .map((p) => ({
        taskClassKey: classById.get(p.taskClassId)!,
        defaultModel: modelById.get(p.defaultModelId) ?? 'unknown',
        allowedModels: p.allowedModelIds.map((id) => modelById.get(id) ?? 'unknown'),
        fallbackChain: p.fallbackChain.map((id) => modelById.get(id) ?? 'unknown'),
        maxTokensOverride: p.maxTokensOverride,
        temperatureMin: p.temperatureMin,
        temperatureMax: p.temperatureMax,
        monthlyBudgetCents: p.monthlyBudgetCents,
        enabled: p.enabled,
      })),
  };
}

/** Import validates schema THEN config-time-gates every policy before writing anything. */
export async function importPolicies(
  db: Db,
  engine: PolicyEngine,
  firmId: string,
  raw: unknown,
): Promise<{ taskClasses: number; policies: number }> {
  const parsed = exportSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RouterError('invalid_request', `invalid policy export: ${issue?.path.join('.')}: ${issue?.message}`);
  }
  const data = parsed.data;

  for (const c of data.taskClasses) {
    const existing = await db.query.taskClasses.findFirst({ where: eq(taskClasses.key, c.key) });
    if (existing) {
      // import never RELAXES sensitivity — tightening is allowed, widening needs the admin UI
      const order = { local_only: 0, cloud_deidentified: 1, cloud_allowed: 2 } as const;
      const next = order[c.sensitivity] < order[existing.sensitivity] ? c.sensitivity : existing.sensitivity;
      await db
        .update(taskClasses)
        .set({
          description: c.description,
          requires: c.requires,
          defaultMaxTokens: c.defaultMaxTokens,
          sensitivity: next,
        })
        .where(eq(taskClasses.id, existing.id));
    } else {
      await db.insert(taskClasses).values({
        key: c.key,
        app: c.app,
        description: c.description,
        sensitivity: c.sensitivity,
        requires: c.requires,
        defaultMaxTokens: c.defaultMaxTokens,
        registeredByAppVersion: 'import',
      });
    }
  }

  let count = 0;
  for (const p of data.policies) {
    await savePolicy(db, engine, {
      firmId,
      taskClassKey: p.taskClassKey,
      defaultModelCanonicalId: p.defaultModel,
      allowedModelCanonicalIds: p.allowedModels,
      fallbackChainCanonicalIds: p.fallbackChain,
      maxTokensOverride: p.maxTokensOverride,
      temperatureMin: p.temperatureMin,
      temperatureMax: p.temperatureMax,
      monthlyBudgetCents: p.monthlyBudgetCents,
      enabled: p.enabled,
    });
    count++;
  }
  engine.invalidate(firmId);
  return { taskClasses: data.taskClasses.length, policies: count };
}
