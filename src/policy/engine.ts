/**
 * Task-class policy engine (Phase 7). Server-side enforcement — the admin UI is a
 * convenience; every request is re-validated here regardless of what the UI allowed
 * to be configured (principle 5). Fail closed everywhere.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { firms, isLocalKind, models, policies, providers, rolePolicies, taskClasses } from '../../db/schema.js';
import { RouterError } from '../gateway/errors.js';
import type { AIRequest } from '../gateway/envelope.js';
import { effectiveCapabilities, type CapabilityKey } from '../catalog/service.js';

type TaskClassRow = typeof taskClasses.$inferSelect;
type PolicyRow = typeof policies.$inferSelect;
type ModelRow = typeof models.$inferSelect;
type ProviderRow = typeof providers.$inferSelect;
type Role = 'admin' | 'partner' | 'staff';

export interface FirmSettings {
  scrubber_mode?: 'block' | 'redact' | 'warn';
  banned_provider_kinds?: string[];
  banned_model_patterns?: string[];
  global_temperature_max?: number;
}

export interface EffectivePolicy {
  taskClass: TaskClassRow;
  policy: PolicyRow;
  defaultModel: ModelRow;
  /** id → row for every allowed + fallback model (default included) */
  modelsById: Map<string, ModelRow>;
  roleRules: Map<Role, boolean>;
  firmSettings: FirmSettings;
}

export interface TaskClassRequires {
  tools?: boolean;
  json_schema?: boolean;
  vision?: boolean;
  /** per-task-class Anthropic knobs (4.2/4.3) */
  caching?: boolean;
  thinking_budget?: number;
  /** response cache opt-in (13.2): TTL seconds; 0/absent = no caching */
  cache_ttl_s?: number;
  /** allow caching for cloud-served responses too (default: local tier only) */
  cache_cloud?: boolean;
}

export function classRequires(tc: TaskClassRow): TaskClassRequires {
  return (tc.requires ?? {}) as TaskClassRequires;
}

/** requirements implied by the REQUEST itself (defense in depth beyond the class contract) */
export function requestRequires(env: AIRequest): CapabilityKey[] {
  const needs: CapabilityKey[] = [];
  if (env.tools?.length) needs.push('tools');
  if (env.responseFormat?.type === 'json_schema') needs.push('json_schema');
  if (env.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image')))
    needs.push('vision');
  return needs;
}

export function missingCapabilities(model: ModelRow, needs: CapabilityKey[]): CapabilityKey[] {
  const caps = effectiveCapabilities(model);
  return needs.filter((n) => !caps[n]);
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function modelBanned(model: ModelRow, settings: FirmSettings): string | undefined {
  if (settings.banned_provider_kinds?.includes(model.providerKind)) {
    return `provider kind ${model.providerKind} is banned by firm policy`;
  }
  for (const pattern of settings.banned_model_patterns ?? []) {
    if (wildcardToRegex(pattern).test(model.canonicalId)) {
      return `model matches banned pattern "${pattern}"`;
    }
  }
  return undefined;
}

/**
 * Full request-time validation of ONE candidate model (7.4/7.5/7.6). Returns the reason it is
 * unusable, or undefined if it passes. Fallback hops re-run this (10.3 uses it too).
 */
export function modelViolation(
  model: ModelRow,
  effective: EffectivePolicy,
  env: AIRequest,
): { code: 'capability_missing' | 'policy_blocked'; reason: string } | undefined {
  if (model.status === 'sunset') {
    return { code: 'policy_blocked', reason: `model ${model.canonicalId} is sunset` };
  }
  // sensitivity (7.5): local_only may NEVER resolve to a non-local-tier model — hard invariant
  if (effective.taskClass.sensitivity === 'local_only' && !isLocalKind(model.providerKind)) {
    return {
      code: 'policy_blocked',
      reason: `local_only task class cannot use non-local model ${model.canonicalId}`,
    };
  }
  const banned = modelBanned(model, effective.firmSettings);
  if (banned) return { code: 'policy_blocked', reason: banned };

  const req = classRequires(effective.taskClass);
  const needs = new Set<CapabilityKey>(requestRequires(env));
  if (req.tools) needs.add('tools');
  if (req.json_schema) needs.add('json_schema');
  if (req.vision) needs.add('vision');
  const missing = missingCapabilities(model, [...needs]);
  if (missing.length > 0) {
    return {
      code: 'capability_missing',
      reason: `model ${model.canonicalId} lacks required capabilities: ${missing.join(', ')}`,
    };
  }
  return undefined;
}

/** Policy cache with explicit invalidation on config change + TTL backstop (7.2). */
export class PolicyEngine {
  private readonly cache = new Map<string, { value: EffectivePolicy; expires: number }>();
  /** hot-path caches (14.4 latency budget): firm settings + provider rows, short TTL */
  private readonly firmCache = new Map<string, { settings: FirmSettings; expires: number }>();
  private readonly providerCache = new Map<string, { row: ProviderRow | undefined; expires: number }>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 30_000,
  ) {}

  invalidate(firmId?: string): void {
    this.firmCache.clear();
    this.providerCache.clear();
    if (!firmId) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) if (key.startsWith(`${firmId}:`)) this.cache.delete(key);
  }

  /** firm settings with a short TTL — invalidated on any config change */
  async firmSettings(firmId: string): Promise<FirmSettings> {
    const hit = this.firmCache.get(firmId);
    if (hit && hit.expires > Date.now()) return hit.settings;
    const firm = await this.db.query.firms.findFirst({ where: eq(firms.id, firmId) });
    const settings = (firm?.settings ?? {}) as FirmSettings;
    this.firmCache.set(firmId, { settings, expires: Date.now() + Math.min(this.ttlMs, 10_000) });
    return settings;
  }

  /** first non-deleted provider of a kind for a firm — request-time hot path */
  async providerFor(firmId: string, kind: ProviderRow['kind']): Promise<ProviderRow | undefined> {
    const key = `${firmId}:${kind}`;
    const hit = this.providerCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.row;
    const row = await this.db.query.providers.findFirst({
      where: (p, { and: and_, eq: eq_, isNull }) =>
        and_(eq_(p.firmId, firmId), eq_(p.kind, kind), isNull(p.deletedAt)),
    });
    this.providerCache.set(key, { row, expires: Date.now() + Math.min(this.ttlMs, 10_000) });
    return row;
  }

  async resolve(firmId: string, taskClassKey: string, firmSettings: FirmSettings): Promise<EffectivePolicy> {
    const cacheKey = `${firmId}:${taskClassKey}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.value;

    const tc = await this.db.query.taskClasses.findFirst({ where: eq(taskClasses.key, taskClassKey) });
    if (!tc) throw new RouterError('policy_blocked', `unknown task class: ${taskClassKey}`);

    const policy = await this.db.query.policies.findFirst({
      where: and(eq(policies.firmId, firmId), eq(policies.taskClassId, tc.id)),
    });
    if (!policy || !policy.enabled) {
      throw new RouterError('policy_blocked', `no enabled policy for task class ${taskClassKey}`);
    }

    const wantedIds = [
      policy.defaultModelId,
      ...policy.allowedModelIds,
      ...policy.fallbackChain,
    ].filter((v, i, a) => a.indexOf(v) === i);
    const rows = await this.db.query.models.findMany({
      where: (m, { inArray }) => inArray(m.id, wantedIds),
    });
    const modelsById = new Map(rows.map((m) => [m.id, m]));
    const defaultModel = modelsById.get(policy.defaultModelId);
    if (!defaultModel) {
      throw new RouterError('policy_blocked', 'policy default model not found in catalog');
    }

    const roleRows = await this.db.query.rolePolicies.findMany({
      where: eq(rolePolicies.policyId, policy.id),
    });
    const roleRules = new Map<Role, boolean>(roleRows.map((r) => [r.role, r.allowed]));

    const value: EffectivePolicy = { taskClass: tc, policy, defaultModel, modelsById, roleRules, firmSettings };
    this.cache.set(cacheKey, { value, expires: Date.now() + this.ttlMs });
    return value;
  }
}

/** Role gating (7.7): explicit deny wins; absence of a rule = allowed. */
export function checkRole(effective: EffectivePolicy, role: Role | undefined): void {
  if (!role) return; // app-level traffic without user context is governed by the app token
  const rule = effective.roleRules.get(role);
  if (rule === false) {
    throw new RouterError('policy_blocked', `role ${role} is not permitted for ${effective.taskClass.key}`);
  }
}

/**
 * Model selection (7.4): the app's requested model is honored only when it is in the allowed
 * set AND passes validation; otherwise the policy default serves. Never silently degrade a
 * failing default — that is an error, not a substitution.
 */
export function selectModel(effective: EffectivePolicy, env: AIRequest): ModelRow {
  if (env.modelRequested) {
    const allowedIds = new Set([effective.policy.defaultModelId, ...effective.policy.allowedModelIds]);
    const match = [...effective.modelsById.values()].find(
      (m) => m.canonicalId === env.modelRequested && allowedIds.has(m.id),
    );
    if (match && !modelViolation(match, effective, env)) return match;
  }
  const violation = modelViolation(effective.defaultModel, effective, env);
  if (violation) throw new RouterError(violation.code, violation.reason);
  return effective.defaultModel;
}

/** Limit application (7.6/7.8): clamp temperature, inject + clamp max_tokens. Mutates env. */
export function applyLimits(effective: EffectivePolicy, env: AIRequest): void {
  const { policy, taskClass, firmSettings } = effective;

  const cap = policy.maxTokensOverride ?? taskClass.defaultMaxTokens;
  env.maxTokens = Math.min(env.maxTokens ?? cap, cap); // never unset (7.8); Anthropic requires it

  if (env.temperature !== undefined) {
    const maxima = [policy.temperatureMax, firmSettings.global_temperature_max].filter(
      (v): v is number => typeof v === 'number',
    );
    for (const m of maxima) env.temperature = Math.min(env.temperature, m);
    if (typeof policy.temperatureMin === 'number') {
      env.temperature = Math.max(env.temperature, policy.temperatureMin);
    }
  }
}
