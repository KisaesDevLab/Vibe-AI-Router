import { z } from 'zod';

/**
 * Environment configuration. The process REFUSES TO BOOT on invalid config (principle: fail
 * closed, never guess). Every variable added here MUST be documented in docs/env.md — the
 * gap-prevention checklist fails the phase otherwise.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** HTTP listen port. 8220 is the suite-registered port for vibe-ai-router (block 8220–8229). */
  PORT: z.coerce.number().int().min(1).max(65535).default(8220),
  /** Listen address. 0.0.0.0 in containers; loopback default for bare dev. */
  HOST: z.string().default('127.0.0.1'),
  /** Postgres connection string. Required — the router has no in-memory persistence mode. */
  DATABASE_URL: z.string().url(),
  /** Redis is OPTIONAL (rate limits / breaker state / response cache). Absent → in-memory fallbacks. */
  REDIS_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Gateway sanity caps (2.9) */
  ROUTER_MAX_BODY_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  ROUTER_MAX_MESSAGES: z.coerce.number().int().positive().default(200),
  ROUTER_MAX_JSON_DEPTH: z.coerce.number().int().positive().default(24),
  /** Catalog sync schedule (5.6); empty string disables the cron */
  CATALOG_SYNC_CRON: z.string().default('15 3 * * *'),
  /** Pre-Phase-11 admin surface; unset → bootstrap admin routes are not registered (Q-018) */
  ADMIN_BOOTSTRAP_TOKEN: z.string().min(16).optional(),
  /** Vault master key, 32B base64. Unset → cloud credentials unavailable; local-only still works. */
  MASTER_KEY: z.string().optional(),
  MASTER_KEY_VERSION: z.coerce.number().int().positive().default(1),
  /** previous key during a rotation window */
  MASTER_KEY_PREVIOUS: z.string().optional(),
  MASTER_KEY_PREVIOUS_VERSION: z.coerce.number().int().positive().optional(),
  /** demoted credentials auto-revoke after this many hours in grace (6.4) */
  CREDENTIAL_GRACE_HOURS: z.coerce.number().positive().default(24),
  /** Resilience (Phase 10) — 0 disables the respective limiter */
  RATE_LIMIT_PER_TOKEN_RPM: z.coerce.number().int().nonnegative().default(600),
  RATE_LIMIT_PER_USER_RPM: z.coerce.number().int().nonnegative().default(240),
  UPSTREAM_MAX_CONCURRENCY: z.coerce.number().int().positive().default(16),
  UPSTREAM_QUEUE_CAP: z.coerce.number().int().nonnegative().default(32),
  BREAKER_OPEN_MS: z.coerce.number().int().positive().default(30_000),
  // total-request budget. For STREAMS this bounds time-to-first-token only (the idle timeout
  // governs after the first chunk — Q-077), so a long 32k-token generation is not walled.
  // For NON-STREAMING it bounds the whole call: raise it for large local completions that
  // don't stream (e.g. txconv 32k statement parse can take many minutes at local speeds).
  ROUTER_TIMEOUT_TOTAL_MS: z.coerce.number().int().positive().default(300_000),
  ROUTER_TIMEOUT_STREAM_IDLE_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Which surfaces this process serves (see RouterRole in src/server/app.ts).
   * `gateway` = /v1 for apps (never publicly routed); `console` = admin UI + /admin-api
   * (safe behind Caddy/TLS); `both` = one process serves everything (dev default).
   */
  ROUTER_ROLE: z.enum(['gateway', 'console', 'both']).default('both'),
  /** Admin UI session signing secret; unset → random per boot (sessions reset on restart) */
  SESSION_SECRET: z.string().min(16).optional(),
  /** Set when the admin UI is served over HTTPS (Caddy) — marks cookies Secure */
  SECURE_COOKIES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Ledger retention (13.7). Default: retain indefinitely (metadata only, cheap). When set,
   * a daily job purges usage_ledger rows older than N days. audit_log is append-only by DB
   * trigger and is deliberately NOT purgeable (compliance evidence, Q-050).
   */
  LEDGER_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  /** SSRF request-time toggle (14.2): deny cloud kinds on private hosts. Leave on. */
  SSRF_DENY_PRIVATE_CLOUD: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Verify each hop's RESULT, not just its status code (src/gateway/verify.ts). On (default),
   * a 200 carrying an unusable result — empty completion, forced-JSON answered with prose,
   * tool arguments that are not JSON, a schema violation — becomes a retryable
   * `invalid_response`, so same-model retry, the fallback chain, and the breaker all engage.
   * Off restores the older behavior in which any 200 is a success. Kill switch only: turn it
   * off to unblock traffic while diagnosing an over-strict schema, not as a steady state.
   */
  ROUTER_VERIFY_RESPONSES: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Deliberately plain output: the logger itself depends on config.
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration — refusing to boot:\n${issues}`);
  }
  return parsed.data;
}
