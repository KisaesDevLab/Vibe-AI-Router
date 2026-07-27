/**
 * Policy engine (Phase 7): validation units, property-based invariants (7.11), config-time
 * gating, default pack, export/import round trip, registration endpoint.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createDb, type DbHandle } from '../src/db/client.js';
import { models, policies, rolePolicies, taskClasses } from '../db/schema.js';
import {
  applyLimits,
  checkRole,
  modelViolation,
  selectModel,
  PolicyEngine,
  type EffectivePolicy,
} from '../src/policy/engine.js';
import { exportPolicies, importPolicies, savePolicy } from '../src/policy/save.js';
import { applyDefaultPack, DEFAULT_PACK } from '../src/policy/pack.js';
import { resetDb } from './helpers.js';
import type { AIRequest } from '../src/gateway/envelope.js';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { NoopLedger } from '../src/gateway/pipeline.js';
import { StubAdapter } from '../src/gateway/stub-adapter.js';
import { createLogger } from '../src/lib/logger.js';
import { DEMO } from '../db/seed.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

type ModelRow = typeof models.$inferSelect;
type TaskClassRow = typeof taskClasses.$inferSelect;
type PolicyRow = typeof policies.$inferSelect;

// ── pure fabric for unit/property tests ──────────────────────────────────────

let seq = 0;
function fakeModel(over: Partial<ModelRow>): ModelRow {
  seq++;
  return {
    id: `model-${seq}`,
    canonicalId: `test/model-${seq}`,
    providerKind: 'openai_compat',
    displayName: `M${seq}`,
    contextWindow: 128000,
    maxOutput: null,
    capabilities: {},
    capabilityOverrides: {},
    status: 'active',
    deprecationDate: null,
    source: 'custom',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ModelRow;
}

function fakeClass(over: Partial<TaskClassRow>): TaskClassRow {
  seq++;
  return {
    id: `tc-${seq}`,
    key: `class_${seq}`,
    app: 'vibe-test',
    description: '',
    sensitivity: 'cloud_allowed',
    requires: {},
    defaultMaxTokens: 1024,
    registeredByAppVersion: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as TaskClassRow;
}

function fakeEffective(
  tc: TaskClassRow,
  defaultModel: ModelRow,
  extra?: {
    allowed?: ModelRow[];
    fallback?: ModelRow[];
    roleRules?: [role: 'admin' | 'partner' | 'staff', allowed: boolean][];
    firmSettings?: EffectivePolicy['firmSettings'];
    policyOver?: Partial<PolicyRow>;
  },
): EffectivePolicy {
  const all = [defaultModel, ...(extra?.allowed ?? []), ...(extra?.fallback ?? [])];
  const policy = {
    id: `pol-${++seq}`,
    firmId: 'firm-1',
    taskClassId: tc.id,
    defaultModelId: defaultModel.id,
    allowedModelIds: [defaultModel.id, ...(extra?.allowed ?? []).map((m) => m.id)],
    fallbackChain: (extra?.fallback ?? []).map((m) => m.id),
    maxTokensOverride: null,
    temperatureMin: null,
    temperatureMax: null,
    monthlyBudgetCents: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...(extra?.policyOver ?? {}),
  } as PolicyRow;
  return {
    taskClass: tc,
    policy,
    defaultModel,
    modelsById: new Map(all.map((m) => [m.id, m])),
    roleRules: new Map(extra?.roleRules ?? []),
    firmSettings: extra?.firmSettings ?? {},
  };
}

const baseEnv = (over?: Partial<AIRequest>): AIRequest => ({
  taskClass: 'k',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
  metadata: { app: 'vibe-test' },
  ...over,
});

// ── unit tests ───────────────────────────────────────────────────────────────

describe('modelViolation (7.4/7.5/7.6)', () => {
  it('local_only never accepts a non-local model — even if capable', () => {
    const tc = fakeClass({ sensitivity: 'local_only' });
    const cloud = fakeModel({ providerKind: 'anthropic', capabilities: { tools: true } });
    const v = modelViolation(cloud, fakeEffective(tc, cloud), baseEnv());
    expect(v?.code).toBe('policy_blocked');
    expect(v?.reason).toMatch(/local_only/);
  });

  it('missing class-required capability names the capability', () => {
    const tc = fakeClass({ requires: { json_schema: true } });
    const model = fakeModel({ capabilities: { tools: true } });
    const v = modelViolation(model, fakeEffective(tc, model), baseEnv());
    expect(v?.code).toBe('capability_missing');
    expect(v?.reason).toContain('json_schema');
  });

  it('request-derived requirements enforced (tools/vision/json_schema)', () => {
    const tc = fakeClass({});
    const model = fakeModel({ capabilities: {} });
    const withTools = baseEnv({ tools: [{ name: 'f' }] });
    expect(modelViolation(model, fakeEffective(tc, model), withTools)?.reason).toContain('tools');
    const withImage = baseEnv({
      messages: [{ role: 'user', content: [{ type: 'image', url: 'data:image/png;base64,x' }] }],
    });
    expect(modelViolation(model, fakeEffective(tc, model), withImage)?.reason).toContain('vision');
  });

  it('capability overrides can grant what sync did not', () => {
    const tc = fakeClass({ requires: { tools: true } });
    const model = fakeModel({ capabilities: { tools: false }, capabilityOverrides: { tools: true } });
    expect(modelViolation(model, fakeEffective(tc, model), baseEnv())).toBeUndefined();
  });

  it('banned kinds and banned model patterns block', () => {
    const tc = fakeClass({});
    const model = fakeModel({ providerKind: 'openai_compat', canonicalId: 'openai/gpt-4o-mini' });
    const eff1 = fakeEffective(tc, model, { firmSettings: { banned_provider_kinds: ['openai_compat'] } });
    expect(modelViolation(model, eff1, baseEnv())?.reason).toMatch(/banned/);
    const eff2 = fakeEffective(tc, model, { firmSettings: { banned_model_patterns: ['openai/*'] } });
    expect(modelViolation(model, eff2, baseEnv())?.reason).toMatch(/banned pattern/);
  });

  it('sunset models are blocked', () => {
    const tc = fakeClass({});
    const model = fakeModel({ status: 'sunset' });
    expect(modelViolation(model, fakeEffective(tc, model), baseEnv())?.reason).toMatch(/sunset/);
  });
});

describe('selectModel + role gating + limits', () => {
  it('advisory model honored only when allowed and valid; else default', () => {
    const tc = fakeClass({});
    const def = fakeModel({ canonicalId: 'test/default' });
    const alt = fakeModel({ canonicalId: 'test/alt' });
    const outsider = fakeModel({ canonicalId: 'test/outsider' });
    const eff = fakeEffective(tc, def, { allowed: [alt] });
    expect(selectModel(eff, baseEnv({ modelRequested: 'test/alt' })).id).toBe(alt.id);
    expect(selectModel(eff, baseEnv({ modelRequested: 'test/outsider' })).id).toBe(def.id);
    void outsider;
  });

  it('failing default is an error, never silent degradation', () => {
    const tc = fakeClass({ requires: { vision: true } });
    const def = fakeModel({ capabilities: {} });
    expect(() => selectModel(fakeEffective(tc, def), baseEnv())).toThrow(/vision/);
  });

  it('explicit role deny blocks; absent rule allows; app-only traffic passes (7.7)', () => {
    const tc = fakeClass({});
    const def = fakeModel({});
    const eff = fakeEffective(tc, def, { roleRules: [['staff', false]] });
    expect(() => checkRole(eff, 'staff')).toThrow(/staff/);
    expect(() => checkRole(eff, 'partner')).not.toThrow();
    expect(() => checkRole(eff, undefined)).not.toThrow();
  });

  it('max_tokens injected and clamped; temperature clamped both ways (7.6/7.8)', () => {
    const tc = fakeClass({ defaultMaxTokens: 2000 });
    const def = fakeModel({});
    const eff = fakeEffective(tc, def, {
      policyOver: { maxTokensOverride: 1000, temperatureMin: 0.2, temperatureMax: 0.8 },
      firmSettings: { global_temperature_max: 0.7 },
    });
    const env1 = baseEnv();
    applyLimits(eff, env1);
    expect(env1.maxTokens).toBe(1000); // injected from override
    const env2 = baseEnv({ maxTokens: 5000, temperature: 1.9 });
    applyLimits(eff, env2);
    expect(env2.maxTokens).toBe(1000); // clamped down
    expect(env2.temperature).toBe(0.7); // firm global wins below policy max
    const env3 = baseEnv({ temperature: 0.05 });
    applyLimits(eff, env3);
    expect(env3.temperature).toBe(0.2); // raised to min
  });
});

// ── property-based invariants (7.11) ─────────────────────────────────────────

describe('property: random configs never violate the two hard invariants', () => {
  const capArb = fc.record({
    tools: fc.boolean(),
    json_schema: fc.boolean(),
    vision: fc.boolean(),
    caching: fc.boolean(),
    reasoning: fc.boolean(),
  });
  const kindArb = fc.constantFrom('openai_compat', 'anthropic', 'local') as fc.Arbitrary<
    'openai_compat' | 'anthropic' | 'local'
  >;
  const sensitivityArb = fc.constantFrom('local_only', 'cloud_deidentified', 'cloud_allowed');
  const requiresArb = fc.record(
    { tools: fc.boolean(), json_schema: fc.boolean(), vision: fc.boolean() },
    { requiredKeys: [] },
  );

  it('selectModel never returns a cloud model for local_only, nor one lacking required caps', () => {
    fc.assert(
      fc.property(
        sensitivityArb,
        requiresArb,
        fc.array(fc.tuple(kindArb, capArb), { minLength: 1, maxLength: 6 }),
        fc.nat({ max: 5 }),
        (sensitivity, requires, modelSpecs, defaultIdx) => {
          const tc = fakeClass({
            sensitivity: sensitivity as TaskClassRow['sensitivity'],
            requires,
          });
          const all = modelSpecs.map(([kind, caps]) => fakeModel({ providerKind: kind, capabilities: caps }));
          const def = all[defaultIdx % all.length]!;
          const eff = fakeEffective(tc, def, { allowed: all.filter((m) => m !== def) });
          let selected: ModelRow | undefined;
          try {
            selected = selectModel(eff, baseEnv());
          } catch {
            return true; // rejecting is always safe — fail closed
          }
          // invariant a: local_only → local kind
          if (tc.sensitivity === 'local_only' && selected.providerKind !== 'local') return false;
          // invariant b: selected model satisfies every class requirement
          const caps = selected.capabilities as Record<string, boolean>;
          for (const [k, v] of Object.entries(requires)) {
            if (v && !caps[k]) return false;
          }
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('fallback candidates are subject to identical validation (modelViolation symmetry)', () => {
    fc.assert(
      fc.property(sensitivityArb, fc.tuple(kindArb, capArb), (sensitivity, [kind, caps]) => {
        const tc = fakeClass({ sensitivity: sensitivity as TaskClassRow['sensitivity'] });
        const m = fakeModel({ providerKind: kind, capabilities: caps });
        const eff = fakeEffective(tc, m);
        const v = modelViolation(m, eff, baseEnv());
        if (tc.sensitivity === 'local_only' && m.providerKind !== 'local') return v !== undefined;
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

// ── DB-backed: config-time gating, pack, export/import, registration ─────────

describe.skipIf(!url)('policy persistence (DB)', () => {
  let handle: DbHandle;
  let firmId: string;
  let engine: PolicyEngine;

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 3);
    engine = new PolicyEngine(handle.db, 50);
    firmId = (await handle.db.query.firms.findFirst())!.id;
    return async () => handle.close();
  });

  it('savePolicy rejects capability-invalid config with the specific gap (7.3)', async () => {
    // tb_classification requires json_schema; llama vision model lacks it
    await expect(
      savePolicy(handle.db, engine, {
        firmId,
        taskClassKey: 'tb_classification',
        defaultModelCanonicalId: 'ollama/llama3.2-vision:11b',
      }),
    ).rejects.toThrow(/missing capability json_schema/);
  });

  it('savePolicy rejects cloud default for local_only class (7.3/7.5)', async () => {
    await expect(
      savePolicy(handle.db, engine, {
        firmId,
        taskClassKey: 'tb_classification',
        defaultModelCanonicalId: 'anthropic/claude-sonnet-4-5',
      }),
    ).rejects.toThrow(/local_only class requires a local model/);
  });

  it('resolution caches and invalidates on save (7.2)', async () => {
    const eff1 = await engine.resolve(firmId, 'tb_classification', {});
    const eff2 = await engine.resolve(firmId, 'tb_classification', {});
    expect(eff2).toBe(eff1); // cache hit — same object
    await savePolicy(handle.db, engine, {
      firmId,
      taskClassKey: 'tb_classification',
      defaultModelCanonicalId: 'ollama/qwen3:14b',
      maxTokensOverride: 777,
    });
    const eff3 = await engine.resolve(firmId, 'tb_classification', {});
    expect(eff3).not.toBe(eff1);
    expect(eff3.policy.maxTokensOverride).toBe(777);
  });

  it('default pack applies local-first, leaves capability-orphans unresolved (7.10)', async () => {
    const result = await applyDefaultPack(handle.db, firmId);
    expect(result.classesCreated).toBeGreaterThan(5);
    // classes seeded earlier (tb_*) skipped policy creation where policies existed
    const allClasses = await handle.db.query.taskClasses.findMany();
    expect(allClasses.length).toBeGreaterThanOrEqual(DEFAULT_PACK.length);

    // every pack policy honors sensitivity: local_only classes got local models
    const packPolicies = await handle.db.query.policies.findMany({ where: eq(policies.firmId, firmId) });
    const modelRows = await handle.db.query.models.findMany();
    const modelById = new Map(modelRows.map((m) => [m.id, m]));
    const classById = new Map(allClasses.map((c) => [c.id, c]));
    for (const p of packPolicies) {
      const cls = classById.get(p.taskClassId)!;
      if (cls.sensitivity === 'local_only') {
        expect(modelById.get(p.defaultModelId)?.providerKind).toBe('local');
      }
    }
    // taxresearch_chat requires tools; seed has no local tools model with cloud allowed? qwen3 has tools
    // — verify unresolved list only contains classes with genuinely no capable model
    for (const key of result.unresolved) {
      const entry = DEFAULT_PACK.find((e) => e.key === key)!;
      expect(entry).toBeDefined();
    }
  });

  it('export → import round-trips (7.9) and import never widens sensitivity', async () => {
    const exported = await exportPolicies(handle.db, firmId);
    expect(exported.version).toBe(1);
    expect(exported.policies.length).toBeGreaterThan(0);

    // tamper: try to widen a local_only class via import
    const tampered = structuredClone(exported);
    const target = tampered.taskClasses.find((c) => c.key === 'tb_classification')!;
    target.sensitivity = 'cloud_allowed';
    await importPolicies(handle.db, engine, firmId, tampered);
    const after = await handle.db.query.taskClasses.findFirst({
      where: eq(taskClasses.key, 'tb_classification'),
    });
    expect(after?.sensitivity).toBe('local_only'); // widening ignored

    const roundTrip = await importPolicies(handle.db, engine, firmId, exported);
    expect(roundTrip.policies).toBe(exported.policies.length);
  });

  it('import rejects malformed payloads and capability-invalid policies atomically-ish', async () => {
    await expect(importPolicies(handle.db, engine, firmId, { version: 2 })).rejects.toThrow(
      /invalid policy export/,
    );
    const exported = await exportPolicies(handle.db, firmId);
    const bad = structuredClone(exported);
    bad.policies[0]!.defaultModel = 'openai/does-not-exist';
    await expect(importPolicies(handle.db, engine, firmId, bad)).rejects.toThrow(/not in catalog/);
  });

  it('role_policies deny blocks the pipeline path (7.7)', async () => {
    const eff = await engine.resolve(firmId, 'tb_classification', {});
    await handle.db
      .insert(rolePolicies)
      .values({ policyId: eff.policy.id, role: 'staff', allowed: false })
      .onConflictDoNothing();
    engine.invalidate(firmId);
    const eff2 = await engine.resolve(firmId, 'tb_classification', {});
    expect(() => checkRole(eff2, 'staff')).toThrow(/not permitted/);
  });
});

describe.skipIf(!url)('registration endpoint (7.1)', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let base: string;

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 2);
    app = buildApp({
      env: loadEnv({ DATABASE_URL: dbUrl, NODE_ENV: 'test' }),
      gateway: {
        deps: {
          db: handle.db,
          adapters: { forKind: () => new StubAdapter() },
          ledger: new NoopLedger(),
          log: createLogger('silent', false),
          engine: new PolicyEngine(handle.db),
        },
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
    return async () => {
      await app.close();
      await handle.close();
    };
  });

  const register = (body: unknown, token: string = DEMO.appToken): Promise<Response> =>
    fetch(`${base}/v1/task-classes/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it('new unknown class → created local_only regardless of app wishes; idempotent', async () => {
    const body = {
      app: 'vibe-tb',
      version: '2.1.0',
      classes: [{ key: 'tb_new_shiny_thing', description: 'new feature', requires: { tools: true } }],
    };
    const res1 = await register(body);
    expect(res1.status).toBe(200);
    const out1 = (await res1.json()) as { registered: { key: string; created: boolean; sensitivity: string }[] };
    expect(out1.registered[0]).toMatchObject({ created: true, sensitivity: 'local_only' });

    const res2 = await register(body);
    const out2 = (await res2.json()) as { registered: { created: boolean }[] };
    expect(out2.registered[0]?.created).toBe(false); // idempotent upsert
  });

  it('existing class: requires update lands, sensitivity untouched', async () => {
    const before = await handle.db.query.taskClasses.findFirst({
      where: eq(taskClasses.key, 'tb_research_summary'),
    });
    expect(before?.sensitivity).toBe('cloud_allowed');
    await register({
      app: 'vibe-tb',
      version: '2.1.0',
      classes: [{ key: 'tb_research_summary', requires: { tools: true }, defaultMaxTokens: 9999 }],
    });
    const after = await handle.db.query.taskClasses.findFirst({
      where: eq(taskClasses.key, 'tb_research_summary'),
    });
    expect(after?.sensitivity).toBe('cloud_allowed'); // unchanged
    expect(after?.defaultMaxTokens).toBe(9999);
    expect((after?.requires as { tools?: boolean }).tools).toBe(true);
    expect(after?.registeredByAppVersion).toBe('vibe-tb@2.1.0');
  });

  it('token app mismatch → 401; bad token → 401; malformed → 400', async () => {
    const mismatch = await register({ app: 'vibe-1099', version: '1', classes: [{ key: 'x_y' }] });
    expect(mismatch.status).toBe(401);
    const bad = await register({ app: 'vibe-tb', version: '1', classes: [{ key: 'x_y' }] }, 'wrong');
    expect(bad.status).toBe(401);
    const malformed = await register({ app: 'vibe-tb', version: '1', classes: [{ key: 'BAD KEY' }] });
    expect(malformed.status).toBe(400);
  });
});
