/**
 * Dashboard aggregation queries (9.7) + billing feed (9.9) + CSV shaping (9.8).
 */
import { and, eq, gte, lt, lte, sql as dsql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { taskClasses, usageLedger } from '../../db/schema.js';

export interface LedgerFilter {
  firmId: string;
  from?: Date;
  to?: Date;
}

function conds(f: LedgerFilter): ReturnType<typeof and> {
  const list = [eq(usageLedger.firmId, f.firmId)];
  if (f.from) list.push(gte(usageLedger.ts, f.from));
  if (f.to) list.push(lte(usageLedger.ts, f.to));
  return and(...list);
}

export type SpendDimension = 'day' | 'model' | 'app' | 'task_class' | 'client';

const DIMENSION_COLUMN = {
  day: dsql<string>`to_char(${usageLedger.ts}, 'YYYY-MM-DD')`,
  model: dsql<string>`COALESCE(${usageLedger.modelServed}, '(none)')`,
  app: dsql<string>`${usageLedger.app}`,
  task_class: dsql<string>`COALESCE(${taskClasses.key}, '(none)')`,
  client: dsql<string>`COALESCE(${usageLedger.clientRef}, '(none)')`,
} as const;

export interface SpendRow {
  dimension: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
  costCents: string;
  costUnknownCount: number;
}

export async function spendBy(db: Db, dim: SpendDimension, f: LedgerFilter): Promise<SpendRow[]> {
  const col = DIMENSION_COLUMN[dim];
  const base = db
    .select({
      dimension: col,
      requests: dsql<number>`COUNT(*)::int`,
      promptTokens: dsql<number>`COALESCE(SUM(${usageLedger.promptTokens}), 0)::int`,
      completionTokens: dsql<number>`COALESCE(SUM(${usageLedger.completionTokens}), 0)::int`,
      cachedReadTokens: dsql<number>`COALESCE(SUM(${usageLedger.cachedReadTokens}), 0)::int`,
      costCents: dsql<string>`COALESCE(SUM(${usageLedger.costCents}), 0)::text`,
      costUnknownCount: dsql<number>`COUNT(*) FILTER (WHERE ${usageLedger.costUnknown})::int`,
    })
    .from(usageLedger);
  const withJoin =
    dim === 'task_class' ? base.leftJoin(taskClasses, eq(usageLedger.taskClassId, taskClasses.id)) : base;
  return withJoin.where(conds(f)).groupBy(col).orderBy(col);
}

export interface LatencyStats {
  p50Ms: number | null;
  p95Ms: number | null;
  requests: number;
}

export async function latencyStats(db: Db, f: LedgerFilter): Promise<LatencyStats> {
  const [row] = await db
    .select({
      p50: dsql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${usageLedger.latencyMs})`,
      p95: dsql<number | null>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${usageLedger.latencyMs})`,
      n: dsql<number>`COUNT(*)::int`,
    })
    .from(usageLedger)
    .where(and(conds(f), eq(usageLedger.status, 'ok')));
  return { p50Ms: row?.p50 ?? null, p95Ms: row?.p95 ?? null, requests: row?.n ?? 0 };
}

/** T&B cost-recovery feed (9.9): line items per client for a yyyymm period. */
export async function billingUsage(
  db: Db,
  firmId: string,
  period: string,
  clientRef?: string,
): Promise<
  {
    clientRef: string;
    engagementRef: string | null;
    app: string;
    taskClass: string | null;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    costCents: string;
  }[]
> {
  const start = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(4, 6)) - 1, 1));
  const end = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(4, 6)), 1));
  const list = [
    eq(usageLedger.firmId, firmId),
    gte(usageLedger.ts, start),
    lt(usageLedger.ts, end), // half-open period — boundary rows never double-bill (QA-B #5)
    dsql`${usageLedger.clientRef} IS NOT NULL`,
  ];
  if (clientRef) list.push(eq(usageLedger.clientRef, clientRef));
  const rows = await db
    .select({
      clientRef: dsql<string>`${usageLedger.clientRef}`,
      engagementRef: usageLedger.engagementRef,
      app: usageLedger.app,
      taskClass: dsql<string | null>`${taskClasses.key}`,
      requests: dsql<number>`COUNT(*)::int`,
      promptTokens: dsql<number>`COALESCE(SUM(${usageLedger.promptTokens}), 0)::int`,
      completionTokens: dsql<number>`COALESCE(SUM(${usageLedger.completionTokens}), 0)::int`,
      costCents: dsql<string>`COALESCE(SUM(${usageLedger.costCents}), 0)::text`,
    })
    .from(usageLedger)
    .leftJoin(taskClasses, eq(usageLedger.taskClassId, taskClasses.id))
    .where(and(...list))
    .groupBy(usageLedger.clientRef, usageLedger.engagementRef, usageLedger.app, taskClasses.key)
    .orderBy(usageLedger.clientRef);
  return rows;
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv<T extends Record<string, unknown>>(rows: T[], columns: (keyof T & string)[]): string {
  const lines = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(','));
  return [columns.join(','), ...lines].join('\n') + '\n';
}

/** raw ledger rows for export (9.8) — metadata only by construction */
export async function ledgerRows(db: Db, f: LedgerFilter, limit = 10_000): Promise<Record<string, unknown>[]> {
  const rows = await db.query.usageLedger.findMany({
    where: (l, { and: and_, eq: eq_, gte: gte_, lte: lte_ }) => {
      const list = [eq_(l.firmId, f.firmId)];
      if (f.from) list.push(gte_(l.ts, f.from));
      if (f.to) list.push(lte_(l.ts, f.to));
      return and_(...list);
    },
    orderBy: (l, { desc }) => desc(l.ts),
    limit,
  });
  return rows as unknown as Record<string, unknown>[];
}
