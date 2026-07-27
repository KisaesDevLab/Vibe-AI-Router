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
