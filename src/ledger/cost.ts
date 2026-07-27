/**
 * Cost computation (9.1). Prices are $/MTok (model_pricing rows); output is CENTS with 6
 * decimal places (numeric(12,6)). Unknown pricing → cost_unknown=true, NEVER silently zero
 * (principle 7). Usage semantics are disjoint (promptTokens excludes cached).
 */
import type { AIUsage } from '../gateway/envelope.js';
import type { modelPricing } from '../../db/schema.js';

type PricingRow = typeof modelPricing.$inferSelect;

export interface CostResult {
  /** cents, 6 dp; null when unknown */
  costCents: string | null;
  costUnknown: boolean;
  /** cache savings in cents vs paying full input rate for cached tokens (9.6) */
  cacheSavingsCents: string | null;
}

/** tokens × $/MTok → cents: tokens * price / 10_000 */
function centsFor(tokens: number, perMtok: string | null): number | null {
  if (perMtok === null) return null;
  return (tokens * Number(perMtok)) / 10_000;
}

export function computeCost(usage: AIUsage, pricing: PricingRow | null): CostResult {
  const anyTokens =
    usage.promptTokens + usage.completionTokens + usage.cachedReadTokens + usage.cacheWriteTokens > 0;
  if (!pricing) {
    return anyTokens
      ? { costCents: null, costUnknown: true, cacheSavingsCents: null }
      : { costCents: '0', costUnknown: false, cacheSavingsCents: null };
  }

  const input = centsFor(usage.promptTokens, pricing.inputPerMtok);
  const output = centsFor(usage.completionTokens, pricing.outputPerMtok);
  // fallback: cached reads at input rate (conservative), cache writes at input rate
  const cacheReadRate = pricing.cacheReadPerMtok ?? pricing.inputPerMtok;
  const cacheWriteRate = pricing.cacheWritePerMtok ?? pricing.inputPerMtok;
  const cacheRead = centsFor(usage.cachedReadTokens, cacheReadRate);
  const cacheWrite = centsFor(usage.cacheWriteTokens, cacheWriteRate);

  // any missing component with nonzero tokens → unknown, never zero
  if (
    (usage.promptTokens > 0 && input === null) ||
    (usage.completionTokens > 0 && output === null) ||
    (usage.cachedReadTokens > 0 && cacheRead === null) ||
    (usage.cacheWriteTokens > 0 && cacheWrite === null)
  ) {
    return { costCents: null, costUnknown: true, cacheSavingsCents: null };
  }

  const total = (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);

  let savings: string | null = null;
  if (usage.cachedReadTokens > 0 && pricing.inputPerMtok !== null && pricing.cacheReadPerMtok !== null) {
    const full = centsFor(usage.cachedReadTokens, pricing.inputPerMtok) ?? 0;
    savings = ((full - (cacheRead ?? 0))).toFixed(6);
  }

  return { costCents: total.toFixed(6), costUnknown: false, cacheSavingsCents: savings };
}
