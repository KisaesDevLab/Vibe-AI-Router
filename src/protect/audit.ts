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
  model_deprecation_warning: z.object({
    policyId: z.string(),
    taskClass: z.string(),
    modelCanonicalId: z.string(),
    modelStatus: z.enum(['deprecated', 'sunset']),
    role: z.enum(['default', 'allowed', 'fallback']),
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
