/**
 * Guard for strings that reach Postgres text columns (QA-D finding #2).
 * Postgres rejects NUL bytes in text values, so an unfiltered NUL in a query param surfaces as
 * a driver exception (→ 500) instead of a clean 400. Other C0/C1 control characters are equally
 * meaningless in filters and identifiers, so they are rejected too.
 *
 * Implemented with code-point checks rather than a regex literal so the source stays free of
 * literal control bytes.
 */
import { z } from 'zod';

export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** A bounded, control-character-free string suitable for DB filters. */
export const safeString = (max = 200): z.ZodEffects<z.ZodString, string, string> =>
  z
    .string()
    .max(max)
    .refine((v) => !hasControlChars(v), { message: 'contains control characters' });
