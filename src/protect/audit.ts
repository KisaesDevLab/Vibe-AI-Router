/**
 * Audit writer — minimal core introduced in Phase 5 (catalog events need it); Phase 8 expands
 * the event registry and adds the query API. The detail payload of EVERY event type is
 * zod-validated so it STRUCTURALLY cannot contain message content (principle 4).
 */
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { auditLog } from '../../db/schema.js';

/** Registry of allowed events → detail schema. audit_log.event is text; this is the gate (Q-005). */
const EVENT_SCHEMAS = {
  config_change: z.object({
    entity: z.string(),
    entityId: z.string().optional(),
    action: z.enum(['create', 'update', 'delete', 'rotate', 'promote', 'revoke']),
    /** metadata only — for credentials this is key_version/last4, never material */
    before: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    after: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  }),
  catalog_sync_completed: z.object({
    source: z.string(),
    sourceSha256: z.string().optional(),
    added: z.number(),
    updated: z.number(),
    pricingChanged: z.number(),
    deprecated: z.number(),
    skipped: z.number(),
    unchanged: z.number(),
  }),
  catalog_sync_failed: z.object({ source: z.string(), reason: z.string().max(500) }),
  credential_test: z.object({
    ok: z.boolean(),
    latencyMs: z.number(),
    errorCode: z.string().optional(),
  }),
  provider_health_changed: z.object({
    from: z.enum(['unknown', 'healthy', 'degraded', 'down']),
    to: z.enum(['unknown', 'healthy', 'degraded', 'down']),
    errorRate: z.number(),
    samples: z.number(),
  }),
  model_deprecation_warning: z.object({
    policyId: z.string(),
    taskClass: z.string(),
    modelCanonicalId: z.string(),
    modelStatus: z.enum(['deprecated', 'sunset']),
    role: z.enum(['default', 'allowed', 'fallback']),
  }),
  // ── pipeline decision events (8.5) — detail schemas structurally exclude content ─────────
  request: z.object({
    status: z.string(),
    modelRequested: z.string().optional(),
    modelServed: z.string().optional(),
    latencyMs: z.number().optional(),
    stream: z.boolean(),
  }),
  blocked_scrubber: z.object({
    mode: z.enum(['block']),
    /** match TYPES + counts only — never matched values (8.3) */
    matches: z.record(z.number()),
  }),
  scrubber_redacted: z.object({ matches: z.record(z.number()) }),
  scrubber_warning: z.object({ matches: z.record(z.number()) }),
  blocked_policy: z.object({ code: z.string(), reason: z.string().max(300) }),
  provider_error: z.object({
    code: z.string(),
    providerStatus: z.number().optional(),
    retryable: z.boolean().optional(),
  }),
  budget_soft_warning: z.object({
    scope: z.string(),
    scopeRef: z.string(),
    period: z.string(),
    spentCents: z.number(),
    limitCents: z.number(),
  }),
} as const;

export type AuditEvent = keyof typeof EVENT_SCHEMAS;

export interface AuditEntry<E extends AuditEvent = AuditEvent> {
  firmId: string;
  event: E;
  detail: z.infer<(typeof EVENT_SCHEMAS)[E]>;
  userId?: string;
  app?: string;
  taskClass?: string;
  model?: string;
  provider?: string;
  requestHash?: string;
}

/** Extend the registry (used by later phases to add events without touching this file's core). */
export function registerAuditEvents(events: Record<string, z.ZodType>): void {
  for (const [name, schema] of Object.entries(events)) {
    (EVENT_SCHEMAS as Record<string, z.ZodType>)[name] = schema;
  }
}

export interface AuditQuery {
  firmId: string;
  from?: Date;
  to?: Date;
  event?: string;
  app?: string;
  userId?: string;
  taskClass?: string;
  limit?: number;
  offset?: number;
}

type AuditRow = typeof auditLog.$inferSelect;

/** Filterable audit query (8.7). */
export async function queryAudit(db: Db, q: AuditQuery): Promise<AuditRow[]> {
  return db.query.auditLog.findMany({
    where: (a, { and, eq, gte, lte }) => {
      const conds = [eq(a.firmId, q.firmId)];
      if (q.from) conds.push(gte(a.ts, q.from));
      if (q.to) conds.push(lte(a.ts, q.to));
      if (q.event) conds.push(eq(a.event, q.event));
      if (q.app) conds.push(eq(a.app, q.app));
      if (q.userId) conds.push(eq(a.userId, q.userId));
      if (q.taskClass) conds.push(eq(a.taskClass, q.taskClass));
      return and(...conds);
    },
    orderBy: (a, { desc }) => desc(a.ts),
    limit: Math.min(q.limit ?? 200, 5000),
    offset: q.offset ?? 0,
  });
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV export (8.7) — same fields as the query rows; detail serialized as JSON. */
export function auditToCsv(rows: AuditRow[]): string {
  const header = 'ts,event,app,task_class,model,provider,user_id,request_hash,detail';
  const lines = rows.map((r) =>
    [r.ts.toISOString(), r.event, r.app, r.taskClass, r.model, r.provider, r.userId, r.requestHash, r.detail]
      .map(csvEscape)
      .join(','),
  );
  return [header, ...lines].join('\n') + '\n';
}

export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  const schema = (EVENT_SCHEMAS as Record<string, z.ZodType>)[entry.event];
  if (!schema) throw new Error(`unregistered audit event: ${entry.event}`);
  const detail: unknown = schema.parse(entry.detail); // throws on structural violation — fail closed
  await db.insert(auditLog).values({
    firmId: entry.firmId,
    event: entry.event,
    detail: detail as Record<string, unknown>,
    userId: entry.userId ?? null,
    app: entry.app ?? null,
    taskClass: entry.taskClass ?? null,
    model: entry.model ?? null,
    provider: entry.provider ?? null,
    requestHash: entry.requestHash ?? null,
  });
}
