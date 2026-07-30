/**
 * Drizzle schema — single source of truth for table types. Applied DDL lives in
 * db/migrations/0001_data_model/{up,down}.sql and must stay in lockstep with this file
 * (gap checklist: no contract doc drift).
 *
 * Conventions: uuid PKs (gen_random_uuid), created_at/updated_at everywhere (updated_at via
 * trigger), soft delete only where the plan calls for it (providers.deleted_at).
 * NOTE the hard invariant: no table stores prompt/completion bodies — metadata + hashes only.
 */
import {
  bigint,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ── enums ────────────────────────────────────────────────────────────────────

export const userRole = pgEnum('user_role', ['admin', 'partner', 'staff']);
/**
 * Provider kinds are the routing key (engine.providerFor picks the firm's provider BY KIND),
 * so a hosted platform that needs its own provider record alongside OpenAI/Groq gets its own
 * kind even when it speaks the OpenAI wire protocol — `digitalocean` (Gradient serverless
 * inference) reuses the openai-compat adapter but routes independently. Order matters:
 * migrations append with ADD VALUE, so new kinds go LAST here to match the DB enum order.
 */
export const PROVIDER_KINDS = ['openai_compat', 'anthropic', 'local', 'digitalocean'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export const providerKind = pgEnum('provider_kind', PROVIDER_KINDS);
export const providerAuthType = pgEnum('provider_auth_type', ['api_key', 'none']);
export const providerStatus = pgEnum('provider_status', ['unknown', 'healthy', 'degraded', 'down']);
export const credentialStatus = pgEnum('credential_status', ['active', 'grace', 'revoked']);
export const modelStatus = pgEnum('model_status', ['active', 'deprecated', 'sunset']);
export const modelSource = pgEnum('model_source', ['synced', 'custom']);
export const sensitivity = pgEnum('sensitivity', ['local_only', 'cloud_deidentified', 'cloud_allowed']);
export const budgetScope = pgEnum('budget_scope', ['firm', 'app', 'user']);
export const requestStatus = pgEnum('request_status', [
  'ok',
  'provider_error',
  'policy_blocked',
  'scrubber_blocked',
  'budget_exceeded',
  'rate_limited',
  'capability_missing',
  'client_abort',
  'error',
]);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// ── 1.1 firms ────────────────────────────────────────────────────────────────

export const firms = pgTable('firms', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /** scrubber_mode, banned_provider_kinds, banned_model_patterns, global_temperature_max, … */
  settings: jsonb('settings').notNull().default({}),
  ...timestamps,
});

// ── 1.2 users ────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id')
    .notNull()
    .references(() => firms.id),
  role: userRole('role').notNull(),
  email: text('email').unique(),
  displayName: text('display_name'),
  /** scrypt hash for admin-UI login (Phase 11); NULL for users who never log in directly */
  passwordHash: text('password_hash'),
  /** SSO subject once suite-wide auth lands; apps pass their own user context meanwhile. */
  externalRef: text('external_ref'),
  ...timestamps,
});

// ── 1.3 providers (soft delete) ──────────────────────────────────────────────

export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id')
    .notNull()
    .references(() => firms.id),
  kind: providerKind('kind').notNull(),
  label: text('label').notNull(),
  baseUrl: text('base_url').notNull(),
  authType: providerAuthType('auth_type').notNull().default('api_key'),
  status: providerStatus('status').notNull().default('unknown'),
  lastHealthAt: timestamp('last_health_at', { withTimezone: true }),
  /** rolling error rate, probe latency, breaker snapshot — never response bodies */
  health: jsonb('health').notNull().default({}),
  /** Azure quirk: deployment-name-as-model mapping { "<canonical>": "<deployment>" } */
  modelMapping: jsonb('model_mapping').notNull().default({}),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...timestamps,
});

// ── 1.4 provider_credentials (never a plaintext column) ─────────────────────

export const providerCredentials = pgTable('provider_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  /** envelope-encrypted (master key wraps per-credential DEK), base64 blob incl. IV/tag */
  ciphertext: text('ciphertext').notNull(),
  keyVersion: integer('key_version').notNull(),
  last4: text('last4').notNull(),
  status: credentialStatus('status').notNull().default('active'),
  graceUntil: timestamp('grace_until', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id),
  rotatedFrom: uuid('rotated_from'),
  ...timestamps,
});

// ── 1.5 models catalog ───────────────────────────────────────────────────────

export const models = pgTable('models', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** e.g. `anthropic/claude-sonnet-4.5`, `openai/gpt-4o-mini`, `ollama/qwen3:14b` */
  canonicalId: text('canonical_id').notNull().unique(),
  providerKind: providerKind('provider_kind').notNull(),
  displayName: text('display_name').notNull(),
  contextWindow: integer('context_window').notNull(),
  maxOutput: integer('max_output'),
  /** { tools, json_schema, vision, caching, reasoning } — inferred by sync */
  capabilities: jsonb('capabilities').notNull().default({}),
  /** manual overrides; survive re-sync and win over `capabilities` (5.5) */
  capabilityOverrides: jsonb('capability_overrides').notNull().default({}),
  status: modelStatus('status').notNull().default('active'),
  deprecationDate: date('deprecation_date'),
  source: modelSource('source').notNull(),
  ...timestamps,
});

// ── 1.6 model_pricing (append-only history) ──────────────────────────────────

export const modelPricing = pgTable(
  'model_pricing',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    /** all per-million-token, nullable as a set: unknown pricing → ledger cost_unknown */
    inputPerMtok: numeric('input_per_mtok', { precision: 14, scale: 6 }),
    outputPerMtok: numeric('output_per_mtok', { precision: 14, scale: 6 }),
    cacheReadPerMtok: numeric('cache_read_per_mtok', { precision: 14, scale: 6 }),
    cacheWritePerMtok: numeric('cache_write_per_mtok', { precision: 14, scale: 6 }),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    ...timestamps,
  },
  (t) => [index('model_pricing_model_effective_idx').on(t.modelId, t.effectiveFrom)],
);

// ── 1.7 task_classes ─────────────────────────────────────────────────────────

export const taskClasses = pgTable('task_classes', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** e.g. `tb_classification` — globally unique across apps by convention `<app>_<purpose>` */
  key: text('key').notNull().unique(),
  app: text('app').notNull(),
  description: text('description').notNull().default(''),
  sensitivity: sensitivity('sensitivity').notNull(),
  /** { tools?: true, json_schema?: true, vision?: true } — capability requirements */
  requires: jsonb('requires').notNull().default({}),
  defaultMaxTokens: integer('default_max_tokens').notNull().default(1024),
  registeredByAppVersion: text('registered_by_app_version'),
  ...timestamps,
});

// ── 1.8 policies ─────────────────────────────────────────────────────────────

export const policies = pgTable(
  'policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    taskClassId: uuid('task_class_id')
      .notNull()
      .references(() => taskClasses.id),
    defaultModelId: uuid('default_model_id')
      .notNull()
      .references(() => models.id),
    allowedModelIds: uuid('allowed_model_ids').array().notNull().default([]),
    fallbackChain: uuid('fallback_chain').array().notNull().default([]),
    maxTokensOverride: integer('max_tokens_override'),
    temperatureMin: real('temperature_min'),
    temperatureMax: real('temperature_max'),
    monthlyBudgetCents: bigint('monthly_budget_cents', { mode: 'number' }),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('policies_firm_task_class_uq').on(t.firmId, t.taskClassId)],
);

// ── 1.9 role_policies ────────────────────────────────────────────────────────

export const rolePolicies = pgTable(
  'role_policies',
  {
    policyId: uuid('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'cascade' }),
    role: userRole('role').notNull(),
    allowed: boolean('allowed').notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.policyId, t.role] })],
);

// ── 1.10 usage_ledger ────────────────────────────────────────────────────────

export const usageLedger = pgTable(
  'usage_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    /** idempotency key: exactly one row per request (9.2) */
    requestId: text('request_id').notNull().unique(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    userId: uuid('user_id').references(() => users.id),
    app: text('app').notNull(),
    /** nullable: requests rejected before task-class resolution still write a row */
    taskClassId: uuid('task_class_id').references(() => taskClasses.id),
    modelRequested: text('model_requested'),
    modelServed: text('model_served'),
    providerId: uuid('provider_id').references(() => providers.id),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    cachedReadTokens: integer('cached_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costCents: numeric('cost_cents', { precision: 12, scale: 6 }),
    costUnknown: boolean('cost_unknown').notNull().default(false),
    /** usage was estimated (tokenizer/heuristic) rather than provider-reported */
    costEstimated: boolean('cost_estimated').notNull().default(false),
    latencyMs: integer('latency_ms'),
    status: requestStatus('status').notNull(),
    engagementRef: text('engagement_ref'),
    clientRef: text('client_ref'),
    /** SHA-256 of canonicalized messages — correlates ledger/audit/logs without bodies */
    requestHash: text('request_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('usage_ledger_firm_ts_idx').on(t.firmId, t.ts),
    index('usage_ledger_task_class_ts_idx').on(t.taskClassId, t.ts),
    index('usage_ledger_client_ref_ts_idx').on(t.clientRef, t.ts),
  ],
);

// ── 1.11 audit_log (append-only; detail is schema-validated to exclude bodies) ─

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    userId: uuid('user_id').references(() => users.id),
    app: text('app'),
    taskClass: text('task_class'),
    /**
     * Kept as text (not a pg enum): the event vocabulary grows every phase (fallback hops,
     * breaker transitions, config changes). Writes are zod-validated app-side against the
     * registered event registry (Q-005).
     */
    event: text('event').notNull(),
    model: text('model'),
    provider: text('provider'),
    detail: jsonb('detail').notNull().default({}),
    requestHash: text('request_hash'),
  },
  (t) => [index('audit_log_firm_ts_idx').on(t.firmId, t.ts), index('audit_log_event_ts_idx').on(t.event, t.ts)],
);

// ── 1.12 budgets_state (denormalized fast path) ─────────────────────────────

export const budgetsState = pgTable(
  'budgets_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: budgetScope('scope').notNull(),
    /** firm id / app name / user id depending on scope */
    scopeRef: text('scope_ref').notNull(),
    /** yyyymm */
    period: char('period', { length: 6 }).notNull(),
    spentCents: numeric('spent_cents', { precision: 14, scale: 6 }).notNull().default('0'),
    softNotifiedAt: timestamp('soft_notified_at', { withTimezone: true }),
    hardStoppedAt: timestamp('hard_stopped_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('budgets_state_scope_period_uq').on(t.scope, t.scopeRef, t.period)],
);

// ── 1.13 app_tokens ──────────────────────────────────────────────────────────

export const appTokens = pgTable('app_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id')
    .notNull()
    .references(() => firms.id),
  /** suite app id, e.g. `vibe-tb`, `vibe-1099` */
  app: text('app').notNull(),
  /** SHA-256 of the bearer token; compared constant-time. Plaintext shown once at issuance. */
  tokenHash: text('token_hash').notNull().unique(),
  scopes: text('scopes').array().notNull().default([]),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ...timestamps,
});
