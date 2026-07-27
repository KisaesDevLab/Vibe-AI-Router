/**
 * Budget engine (9.4/9.5). Limits live in firm.settings.budgets:
 *   { firm_monthly_cents?, apps?: {app: cents}, users?: {userId: cents}, soft_pct? (default 80) }
 * plus policy.monthlyBudgetCents (per task class, checked via indexed ledger SUM).
 * budgets_state is the denormalized fast path for firm/app/user scopes. Most restrictive
 * wins: ANY hard-stopped scope rejects.
 */
import { and, eq, gte, sql as dsql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { budgetsState, usageLedger } from '../../db/schema.js';
import { RouterError } from '../gateway/errors.js';

export interface BudgetSettings {
  firm_monthly_cents?: number;
  apps?: Record<string, number>;
  users?: Record<string, number>;
  /** soft-warning threshold as % of limit */
  soft_pct?: number;
}

export interface BudgetScopeCheck {
  scope: 'firm' | 'app' | 'user' | 'task_class';
  scopeRef: string;
  limitCents: number;
  spentCents: number;
}

export interface BudgetCheckResult {
  softWarnings: BudgetScopeCheck[];
}

export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function spentFor(db: Db, scope: 'firm' | 'app' | 'user', scopeRef: string, period: string): Promise<number> {
  const row = await db.query.budgetsState.findFirst({
    where: and(
      eq(budgetsState.scope, scope),
      eq(budgetsState.scopeRef, scopeRef),
      eq(budgetsState.period, period),
    ),
  });
  return row ? Number(row.spentCents) : 0;
}

/**
 * Pre-request fast-path check. Throws budget_exceeded on any hard limit; returns soft
 * warnings for the relay to surface as a response header + audit.
 */
export async function checkBudgets(
  db: Db,
  params: {
    firmId: string;
    app: string;
    userId?: string;
    taskClassId: string;
    settings: BudgetSettings;
    policyMonthlyCents: number | null;
    now?: Date;
  },
): Promise<BudgetCheckResult> {
  const period = currentPeriod(params.now);
  const softPct = (params.settings.soft_pct ?? 80) / 100;
  const softWarnings: BudgetScopeCheck[] = [];

  const evaluate = (check: BudgetScopeCheck): void => {
    if (check.spentCents >= check.limitCents) {
      throw new RouterError('budget_exceeded', `${check.scope} budget exhausted for ${period}`, {
        detail: { scope: check.scope, period },
      });
    }
    if (check.spentCents >= check.limitCents * softPct) softWarnings.push(check);
  };

  if (params.settings.firm_monthly_cents !== undefined) {
    evaluate({
      scope: 'firm',
      scopeRef: params.firmId,
      limitCents: params.settings.firm_monthly_cents,
      spentCents: await spentFor(db, 'firm', params.firmId, period),
    });
  }
  const appLimit = params.settings.apps?.[params.app];
  if (appLimit !== undefined) {
    evaluate({
      scope: 'app',
      scopeRef: params.app,
      limitCents: appLimit,
      spentCents: await spentFor(db, 'app', params.app, period),
    });
  }
  const userLimit = params.userId ? params.settings.users?.[params.userId] : undefined;
  if (userLimit !== undefined && params.userId) {
    evaluate({
      scope: 'user',
      scopeRef: params.userId,
      limitCents: userLimit,
      spentCents: await spentFor(db, 'user', params.userId, period),
    });
  }

  // per-task-class budget (policy.monthly_budget_cents) via indexed ledger SUM
  if (params.policyMonthlyCents !== null && params.policyMonthlyCents !== undefined) {
    const monthStart = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(4)) - 1, 1));
    const [row] = await db
      .select({ total: dsql<string>`COALESCE(SUM(${usageLedger.costCents}), 0)` })
      .from(usageLedger)
      .where(and(eq(usageLedger.taskClassId, params.taskClassId), gte(usageLedger.ts, monthStart)));
    evaluate({
      scope: 'task_class',
      scopeRef: params.taskClassId,
      limitCents: params.policyMonthlyCents,
      spentCents: Number(row?.total ?? 0),
    });
  }

  return { softWarnings };
}

/** Atomic post-request spend increment across firm/app/user scopes (9.4). */
export async function recordSpend(
  db: Db,
  params: { firmId: string; app: string; userId?: string; costCents: number; now?: Date },
): Promise<void> {
  if (params.costCents <= 0) return;
  const period = currentPeriod(params.now);
  const scopes: { scope: 'firm' | 'app' | 'user'; ref: string }[] = [
    { scope: 'firm', ref: params.firmId },
    { scope: 'app', ref: params.app },
    ...(params.userId ? [{ scope: 'user' as const, ref: params.userId }] : []),
  ];
  const amount = params.costCents.toFixed(6);
  for (const { scope, ref } of scopes) {
    await db
      .insert(budgetsState)
      .values({ scope, scopeRef: ref, period, spentCents: amount })
      .onConflictDoUpdate({
        target: [budgetsState.scope, budgetsState.scopeRef, budgetsState.period],
        set: { spentCents: dsql`${budgetsState.spentCents} + ${amount}` },
      });
  }
}
