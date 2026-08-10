/**
 * Catalog service (5.1/5.5/5.8): custom-model CRUD, capability overrides, effective
 * capabilities, and pricing-at-timestamp lookup (the ledger's costing input).
 */
import { z } from 'zod';
import { and, eq, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { modelPricing, models, policies, PROVIDER_KINDS } from '../../db/schema.js';
import { RouterError } from '../gateway/errors.js';

type ModelRow = typeof models.$inferSelect;
type PricingRow = typeof modelPricing.$inferSelect;

export const CAPABILITY_KEYS = ['tools', 'json_schema', 'vision', 'caching', 'reasoning'] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

const capabilitiesSchema = z
  .object({
    tools: z.boolean().optional(),
    json_schema: z.boolean().optional(),
    vision: z.boolean().optional(),
    caching: z.boolean().optional(),
    reasoning: z.boolean().optional(),
  })
  .strict();

export const customModelSchema = z.object({
  canonicalId: z
    .string()
    .regex(/^[a-z0-9_-]+\/[A-Za-z0-9_.:\-]+$/, 'expected family/native-name, e.g. ollama/qwen3:14b'),
  providerKind: z.enum(PROVIDER_KINDS),
  displayName: z.string().min(1).max(200),
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive().optional(),
  capabilities: capabilitiesSchema.default({}),
  /** pricing optional (5.8): absent → requests cost `cost_unknown=true`, never silently zero */
  pricing: z
    .object({
      inputPerMtok: z.number().nonnegative(),
      outputPerMtok: z.number().nonnegative(),
      cacheReadPerMtok: z.number().nonnegative().optional(),
      cacheWritePerMtok: z.number().nonnegative().optional(),
    })
    .optional(),
});

export type CustomModelInput = z.infer<typeof customModelSchema>;

/** overrides win over synced capabilities and survive re-sync (5.5) */
export function effectiveCapabilities(model: ModelRow): Record<CapabilityKey, boolean> {
  const base = (model.capabilities ?? {}) as Record<string, boolean>;
  const overrides = (model.capabilityOverrides ?? {}) as Record<string, boolean>;
  const out = {} as Record<CapabilityKey, boolean>;
  for (const key of CAPABILITY_KEYS) out[key] = overrides[key] ?? base[key] ?? false;
  return out;
}

export async function createCustomModel(db: Db, input: unknown): Promise<ModelRow> {
  const parsed = customModelSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RouterError('invalid_request', `invalid model: ${issue?.path.join('.')}: ${issue?.message}`);
  }
  const m = parsed.data;
  const existing = await db.query.models.findFirst({ where: eq(models.canonicalId, m.canonicalId) });
  if (existing) throw new RouterError('invalid_request', `model already exists: ${m.canonicalId}`);
  const [row] = await db
    .insert(models)
    .values({
      canonicalId: m.canonicalId,
      providerKind: m.providerKind,
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      maxOutput: m.maxOutput ?? null,
      capabilities: m.capabilities,
      source: 'custom',
    })
    .returning();
  if (!row) throw new Error('insert returned nothing');
  if (m.pricing) {
    await db.insert(modelPricing).values({
      modelId: row.id,
      effectiveFrom: new Date(),
      inputPerMtok: String(m.pricing.inputPerMtok),
      outputPerMtok: String(m.pricing.outputPerMtok),
      cacheReadPerMtok: m.pricing.cacheReadPerMtok !== undefined ? String(m.pricing.cacheReadPerMtok) : null,
      cacheWritePerMtok:
        m.pricing.cacheWritePerMtok !== undefined ? String(m.pricing.cacheWritePerMtok) : null,
    });
  }
  return row;
}

const pricingInputSchema = z.object({
  inputPerMtok: z.number().nonnegative(),
  outputPerMtok: z.number().nonnegative(),
  cacheReadPerMtok: z.number().nonnegative().optional(),
  cacheWritePerMtok: z.number().nonnegative().optional(),
});

export const updateModelSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutput: z.number().int().positive().nullable().optional(),
    /** written to capability_overrides (survives re-sync, 5.5) — full replace, not a merge */
    capabilities: capabilitiesSchema.optional(),
    /** appends a new model_pricing row effective now (history is append-only, 5.4) */
    pricing: pricingInputSchema.optional(),
  })
  .strict();

export type UpdateModelInput = z.infer<typeof updateModelSchema>;

/**
 * Edit a model (11.4). Capability edits write to capability_overrides for ANY source — they
 * win over synced capabilities and survive re-sync (5.5). Base specs (name / context window /
 * max output) and pricing are operator-owned only for 'custom' and 'provider' (discovered)
 * models; a 'synced' row is feed-managed and would be clobbered on the next sync, so base
 * edits there are rejected with a clear message (use capability overrides instead). Discovered
 * models are the intended target: they ship with a placeholder context window and no pricing.
 */
export async function updateModel(db: Db, modelId: string, input: unknown): Promise<ModelRow> {
  const parsed = updateModelSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RouterError('invalid_request', `invalid edit: ${issue?.path.join('.')}: ${issue?.message}`);
  }
  const patch = parsed.data;
  const model = await db.query.models.findFirst({ where: eq(models.id, modelId) });
  if (!model) throw new RouterError('invalid_request', 'model not found');

  const touchesBase =
    patch.displayName !== undefined ||
    patch.contextWindow !== undefined ||
    patch.maxOutput !== undefined ||
    patch.pricing !== undefined;
  if (touchesBase && model.source === 'synced') {
    throw new RouterError(
      'invalid_request',
      'synced models are feed-managed; only capability overrides can be edited (they survive re-sync)',
    );
  }

  const set: Partial<typeof models.$inferInsert> = {};
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.contextWindow !== undefined) set.contextWindow = patch.contextWindow;
  if (patch.maxOutput !== undefined) set.maxOutput = patch.maxOutput; // null clears it
  if (patch.capabilities !== undefined) set.capabilityOverrides = patch.capabilities;
  if (Object.keys(set).length > 0) await db.update(models).set(set).where(eq(models.id, modelId));

  if (patch.pricing !== undefined) {
    await db.insert(modelPricing).values({
      modelId,
      effectiveFrom: new Date(),
      inputPerMtok: String(patch.pricing.inputPerMtok),
      outputPerMtok: String(patch.pricing.outputPerMtok),
      cacheReadPerMtok:
        patch.pricing.cacheReadPerMtok !== undefined ? String(patch.pricing.cacheReadPerMtok) : null,
      cacheWritePerMtok:
        patch.pricing.cacheWritePerMtok !== undefined ? String(patch.pricing.cacheWritePerMtok) : null,
    });
  }

  const updated = await db.query.models.findFirst({ where: eq(models.id, modelId) });
  if (!updated) throw new Error('model vanished during update');
  return updated;
}

export async function setCapabilityOverrides(db: Db, modelId: string, overrides: unknown): Promise<void> {
  const parsed = capabilitiesSchema.safeParse(overrides);
  if (!parsed.success) throw new RouterError('invalid_request', 'invalid capability overrides');
  await db.update(models).set({ capabilityOverrides: parsed.data }).where(eq(models.id, modelId));
}

/** Custom models referenced by any policy are retired (sunset), never deleted. */
export async function retireCustomModel(db: Db, modelId: string): Promise<'deleted' | 'sunset'> {
  const model = await db.query.models.findFirst({ where: eq(models.id, modelId) });
  if (!model) throw new RouterError('invalid_request', 'model not found');
  if (model.source !== 'custom') {
    throw new RouterError('invalid_request', 'synced models are managed by sync; set overrides instead');
  }
  const referencing = await db.query.policies.findFirst({ where: eq(policies.defaultModelId, modelId) });
  const all = referencing ? [referencing] : await db.query.policies.findMany();
  const referenced =
    referencing !== undefined ||
    all.some((p) => p.allowedModelIds.includes(modelId) || p.fallbackChain.includes(modelId));
  if (referenced) {
    await db.update(models).set({ status: 'sunset' }).where(eq(models.id, modelId));
    return 'sunset';
  }
  await db.delete(models).where(eq(models.id, modelId));
  return 'deleted';
}

/** Latest pricing row effective at `ts` (9.1's lookup). null → cost_unknown. */
export async function pricingAt(db: Db, modelId: string, ts: Date): Promise<PricingRow | null> {
  const row = await db.query.modelPricing.findFirst({
    where: and(eq(modelPricing.modelId, modelId), lte(modelPricing.effectiveFrom, ts)),
    orderBy: (p, { desc }) => desc(p.effectiveFrom),
  });
  return row ?? null;
}

/** Policies referencing deprecated/sunset models (5.7). */
export async function findRetiredModelReferences(
  db: Db,
): Promise<
  {
    policyId: string;
    firmId: string;
    taskClassId: string;
    modelId: string;
    canonicalId: string;
    status: 'deprecated' | 'sunset';
    role: 'default' | 'allowed' | 'fallback';
  }[]
> {
  const retired = await db.query.models.findMany({
    where: (m, { inArray: inArr }) => inArr(m.status, ['deprecated', 'sunset']),
  });
  if (retired.length === 0) return [];
  const retiredById = new Map(retired.map((m) => [m.id, m]));
  const allPolicies = await db.query.policies.findMany();
  const out: Awaited<ReturnType<typeof findRetiredModelReferences>> = [];
  for (const p of allPolicies) {
    const hit = (modelId: string, role: 'default' | 'allowed' | 'fallback'): void => {
      const m = retiredById.get(modelId);
      if (m) {
        out.push({
          policyId: p.id,
          firmId: p.firmId,
          taskClassId: p.taskClassId,
          modelId,
          canonicalId: m.canonicalId,
          status: m.status as 'deprecated' | 'sunset',
          role,
        });
      }
    };
    hit(p.defaultModelId, 'default');
    for (const id of p.allowedModelIds) hit(id, 'allowed');
    for (const id of p.fallbackChain) hit(id, 'fallback');
  }
  return out;
}
