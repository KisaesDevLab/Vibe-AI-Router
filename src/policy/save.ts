/**
 * Config-time policy persistence (7.3) + export/import (7.9). Saving is gated: every model in
 * default/allowed/fallback must satisfy the task class's requirements and sensitivity — the
 * save is rejected with the SPECIFIC missing capability, before anything hits the database.
 */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { firms, isLocalKind, models, policies, taskClasses } from '../../db/schema.js';
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
  /**
   * Canonical ids the operator has explicitly acknowledged as third-party hosted (Q-098) —
   * e.g. Claude on DigitalOcean, whose retention terms are Anthropic's. Binding such a model
   * without acknowledging it is refused server-side (invariant 6: the UI confirm is a
   * convenience, the router decides).
   */
  acknowledgedModels?: string[];
  /** where the acknowledgement came from — recorded in the audit row (Q-100) */
  acknowledgedVia?: 'console' | 'import';
}

/** The config-time gate (7.3): returns the specific reason a model may not serve this class. */
export function configTimeViolation(model: ModelRow, tc: TaskClassRow): string | undefined {
  if (tc.sensitivity === 'local_only' && !isLocalKind(model.providerKind)) {
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

  const existing = await db.query.policies.findFirst({
    where: and(eq(policies.firmId, input.firmId), eq(policies.taskClassId, tc.id)),
  });
  // an acknowledgement persists on the policy (Q-100): what this save brings plus what was
  // already confirmed for this class, so an unrelated edit never re-asks
  const acknowledged = new Set([...(existing?.acknowledgedModels ?? []), ...(input.acknowledgedModels ?? [])]);
  const problems: string[] = [];
  for (const id of new Set(canonicalIds)) {
    const model = byCanonical.get(id);
    if (!model) {
      problems.push(`${id}: not in catalog`);
      continue;
    }
    const violation = configTimeViolation(model, tc);
    if (violation) problems.push(violation);
    // third-party-hosted models bind only with an explicit acknowledgement (Q-098)
    if (model.thirdPartyHosted && !acknowledged.has(id)) {
      problems.push(
        `${id}: third-party hosted — ${model.retentionNote ?? 'retention terms are the upstream vendor’s'} ` +
          `(acknowledge it in acknowledgedModels to bind)`,
      );
    }
  }
  if (problems.length > 0) {
    throw new RouterError('invalid_request', `policy rejected: ${problems.join('; ')}`, {
      detail: { problems },
    });
  }

  const defaultModel = byCanonical.get(input.defaultModelCanonicalId)!;
  const allowedIds = (input.allowedModelCanonicalIds ?? []).map((c) => byCanonical.get(c)!.id);
  const fallbackIds = (input.fallbackChainCanonicalIds ?? []).map((c) => byCanonical.get(c)!.id);

  // persisted acknowledgements = bound flagged models that are acknowledged (pruned to what is
  // actually bound now); acknowledgedAt moves only when the set grows
  const boundFlagged = [...new Set(canonicalIds)].filter((c) => byCanonical.get(c)?.thirdPartyHosted);
  const acknowledgedNow = boundFlagged.filter((c) => acknowledged.has(c)).sort();
  const previouslyAcknowledged = new Set(existing?.acknowledgedModels ?? []);
  const newlyAcknowledged = acknowledgedNow.filter((c) => !previouslyAcknowledged.has(c));
  const values = {
    defaultModelId: defaultModel.id,
    allowedModelIds: allowedIds,
    fallbackChain: fallbackIds,
    maxTokensOverride: input.maxTokensOverride ?? null,
    temperatureMin: input.temperatureMin ?? null,
    temperatureMax: input.temperatureMax ?? null,
    monthlyBudgetCents: input.monthlyBudgetCents ?? null,
    enabled: input.enabled ?? true,
    acknowledgedModels: acknowledgedNow,
    acknowledgedAt:
      newlyAcknowledged.length > 0 ? new Date() : acknowledgedNow.length > 0 ? (existing?.acknowledgedAt ?? new Date()) : null,
  };
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
        // third-party-hosted bindings and their acknowledgement provenance (Q-098/Q-100): what
        // is acknowledged on the row after this save, what this save newly acknowledged, and how
        ...(boundFlagged.length > 0 ? { acknowledgedThirdParty: acknowledgedNow.join(',') } : {}),
        ...(newlyAcknowledged.length > 0
          ? {
              newlyAcknowledged: newlyAcknowledged.join(','),
              acknowledgedVia: input.acknowledgedVia ?? 'console',
            }
          : {}),
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
      /**
       * Third-party-hosted models acknowledged on this policy (Q-100). Optional so pre-0008
       * exports still parse — but a flagged model NOT listed here is refused on import, exactly
       * as an unacknowledged console save is. An export made after the acknowledgement carries
       * it; a hand-edited or pre-0007 file does not get one for free.
       */
      acknowledgedModels: z.array(z.string()).default([]),
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
        acknowledgedModels: [...p.acknowledgedModels],
      })),
  };
}

export interface UnacknowledgedBinding {
  firmId: string;
  policyId: string;
  taskClassKey: string;
  /** canonical ids bound to the policy that are third-party hosted and not acknowledged */
  models: string[];
}

/**
 * Policies binding a third-party-hosted model without a persisted acknowledgement (Q-100):
 * the case migration 0007's backfill creates for bindings saved before the flag existed.
 * Reported at boot and after every discovery run; never blocks traffic by itself (an upgrade
 * must not silently take down a class that was routing yesterday) — the operator re-saves
 * the policy through the console to acknowledge, or rebinds.
 */
export async function findUnacknowledgedThirdPartyBindings(db: Db): Promise<UnacknowledgedBinding[]> {
  const flagged = await db.query.models.findMany({ where: eq(models.thirdPartyHosted, true) });
  if (flagged.length === 0) return [];
  const flaggedById = new Map(flagged.map((m) => [m.id, m.canonicalId]));
  const rows = await db.query.policies.findMany();
  const classes = await db.query.taskClasses.findMany();
  const classById = new Map(classes.map((c) => [c.id, c.key]));
  const out: UnacknowledgedBinding[] = [];
  for (const p of rows) {
    const acknowledged = new Set(p.acknowledgedModels);
    const bound = [p.defaultModelId, ...p.allowedModelIds, ...p.fallbackChain];
    const missing = [...new Set(bound.map((id) => flaggedById.get(id)).filter((c): c is string => !!c))].filter(
      (c) => !acknowledged.has(c),
    );
    if (missing.length > 0) {
      out.push({ firmId: p.firmId, policyId: p.id, taskClassKey: classById.get(p.taskClassId) ?? p.taskClassId, models: missing });
    }
  }
  return out;
}

export interface InvalidBinding {
  firmId: string;
  policyId: string;
  taskClassKey: string;
  model: string;
  reason: string;
}

/**
 * Policies whose bound models no longer pass config-time gating (Q-097 review): e.g. a
 * `local_ocr` row that advertised json_schema before the kind ceiling existed. Requests to
 * such a class already fail closed (`capability_missing`); this makes the breakage visible at
 * boot instead of at the first request after an upgrade.
 */
export async function findInvalidBindings(db: Db): Promise<InvalidBinding[]> {
  const rows = await db.query.policies.findMany();
  if (rows.length === 0) return [];
  const allModels = await db.query.models.findMany();
  const modelById = new Map(allModels.map((m) => [m.id, m]));
  const classes = await db.query.taskClasses.findMany();
  const classById = new Map(classes.map((c) => [c.id, c]));
  const out: InvalidBinding[] = [];
  for (const p of rows) {
    const tc = classById.get(p.taskClassId);
    if (!tc) continue;
    for (const id of new Set([p.defaultModelId, ...p.allowedModelIds, ...p.fallbackChain])) {
      const model = modelById.get(id);
      if (!model) continue;
      const reason = configTimeViolation(model, tc);
      if (reason) out.push({ firmId: p.firmId, policyId: p.id, taskClassKey: tc.key, model: model.canonicalId, reason });
    }
  }
  return out;
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
      // only what the export itself carries (Q-100) — a pre-0008 or hand-edited file that binds
      // a flagged model without an acknowledgement is refused, same as an unacknowledged save
      acknowledgedModels: p.acknowledgedModels,
      acknowledgedVia: 'import',
    });
    count++;
  }
  engine.invalidate(firmId);
  return { taskClasses: data.taskClasses.length, policies: count };
}
