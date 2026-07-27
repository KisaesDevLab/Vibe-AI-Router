/**
 * Catalog service (5.1/5.5/5.8): custom-model CRUD, capability overrides, effective
 * capabilities, and pricing-at-timestamp lookup (the ledger's costing input).
 */
import { z } from 'zod';
import { and, eq, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { modelPricing, models, policies } from '../../db/schema.js';
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
  providerKind: z.enum(['openai_compat', 'anthropic', 'local']),
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
