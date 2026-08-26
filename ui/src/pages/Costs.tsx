import { useEffect, useMemo, useState } from 'react';
import { api, fmtCost, fmtTokens, mounted, type CostBreakdownRow } from '../api';

/**
 * Costs view: AI spend by app, task class (what a policy binds), and model — from a single
 * ledger pass (/admin-api/dashboard/costs) pivoted client-side, so switching dimension or
 * expanding a row costs no round trip.
 *
 * Unpriced requests are surfaced, never folded into the total: a model with no pricing row
 * bills `cost_unknown` and its real cost is NOT in these figures (ledger invariant 8).
 */

type Dim = 'app' | 'taskClass' | 'model';

const DIM_LABEL: Record<Dim, string> = {
  app: 'App',
  taskClass: 'Task class (policy)',
  model: 'Model',
};

/** The two dimensions a row drills into — whichever aren't the primary grouping. */
const OTHERS: Record<Dim, Dim[]> = {
  app: ['taskClass', 'model'],
  taskClass: ['model', 'app'],
  model: ['taskClass', 'app'],
};

interface Totals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
  costCents: number;
  costUnknownCount: number;
  estimatedCount: number;
}

const ZERO: Totals = {
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedReadTokens: 0,
  costCents: 0,
  costUnknownCount: 0,
  estimatedCount: 0,
};

const add = (a: Totals, r: CostBreakdownRow): Totals => ({
  requests: a.requests + r.requests,
  promptTokens: a.promptTokens + r.promptTokens,
  completionTokens: a.completionTokens + r.completionTokens,
  cachedReadTokens: a.cachedReadTokens + r.cachedReadTokens,
  costCents: a.costCents + Number(r.costCents),
  costUnknownCount: a.costUnknownCount + r.costUnknownCount,
  estimatedCount: a.estimatedCount + r.estimatedCount,
});

function groupBy(rows: CostBreakdownRow[], dim: Dim): { key: string; totals: Totals }[] {
  const map = new Map<string, Totals>();
  for (const r of rows) map.set(r[dim], add(map.get(r[dim]) ?? ZERO, r));
  return [...map.entries()]
    .map(([key, totals]) => ({ key, totals }))
    .sort((a, b) => b.totals.costCents - a.totals.costCents || b.totals.requests - a.totals.requests);
}

/** yyyy-mm-dd in LOCAL time — toISOString would shift the day for negative UTC offsets. */
const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

type PresetKey = 'this_month' | 'last_month' | 'last_30' | 'all';

function presetRange(preset: PresetKey): { from: string; to: string } {
  const now = new Date();
  switch (preset) {
    case 'this_month':
      return { from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: '' };
    case 'last_month':
      return {
        from: isoDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: isoDay(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
    case 'last_30':
      return { from: isoDay(new Date(now.getTime() - 30 * 86_400_000)), to: '' };
    case 'all':
      return { from: '', to: '' };
  }
}

export function Costs(): JSX.Element {
  const [rows, setRows] = useState<CostBreakdownRow[] | null>(null);
  const [dim, setDim] = useState<Dim>('app');
  const [preset, setPreset] = useState<PresetKey>('this_month');
  const [range, setRange] = useState(() => presetRange('this_month'));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState('');

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (range.from) p.set('from', range.from);
    // `to` is an inclusive day in the picker; send end-of-day so that day's rows are counted
    if (range.to) p.set('to', `${range.to}T23:59:59.999`);
    return p.toString();
  }, [range]);

  useEffect(() => {
    setError('');
    api
      .get<{ rows: CostBreakdownRow[] }>(`/admin-api/dashboard/costs?${query}`)
      .then((r) => setRows(r.rows))
      .catch(() => setError('Could not load costs.'));
  }, [query]);

  const grouped = useMemo(() => groupBy(rows ?? [], dim), [rows, dim]);
  const total = useMemo(() => (rows ?? []).reduce(add, ZERO), [rows]);
  const maxCost = Math.max(1e-9, ...grouped.map((g) => g.totals.costCents));

  const applyPreset = (p: PresetKey): void => {
    setPreset(p);
    setRange(presetRange(p));
    setExpanded(null);
  };

  return (
    <>
      <h1>Costs</h1>
      <p className="sub">
        AI spend by app, task class, and model — from the usage ledger, which stores metadata
        and token counts only, never prompt content.
      </p>

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <select
            value={preset}
            onChange={(e) => applyPreset(e.target.value as PresetKey)}
            style={{ width: 150 }}
            data-testid="cost-period"
          >
            <option value="this_month">this month</option>
            <option value="last_month">last month</option>
            <option value="last_30">last 30 days</option>
            <option value="all">all time</option>
          </select>
          <div>
            <span className="sub">from</span>
            <input
              type="date"
              value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
              style={{ width: 160 }}
            />
          </div>
          <div>
            <span className="sub">to</span>
            <input
              type="date"
              value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
              style={{ width: 160 }}
            />
          </div>
          <a
            href={mounted(`/admin-api/dashboard/costs.csv?${query}`)}
            className="chip"
            style={{ marginLeft: 'auto', textDecoration: 'none' }}
            data-testid="cost-csv"
          >
            Export CSV
          </a>
        </div>
      </div>

      <div className="cards">
        <div className="stat">
          <div className="k">Total spend</div>
          <div className="v num" data-testid="cost-total">{fmtCost(total.costCents)}</div>
        </div>
        <div className="stat">
          <div className="k">Requests</div>
          <div className="v num">{total.requests.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="k">Tokens in / out</div>
          <div className="v num">
            {fmtTokens(total.promptTokens)}
            <small> / {fmtTokens(total.completionTokens)}</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">Unpriced requests</div>
          <div className="v num">{total.costUnknownCount.toLocaleString()}</div>
        </div>
      </div>

      {total.costUnknownCount > 0 && (
        <div className="notice">
          {total.costUnknownCount.toLocaleString()} request
          {total.costUnknownCount === 1 ? '' : 's'} ran on a model with no pricing in the catalog, so
          their real cost is <strong>not included</strong> in these totals. Set pricing in{' '}
          <strong>Model catalog → Edit</strong> (or run “Detect from DO docs”) to price them going forward —
          ledger rows are recomputed against the pricing in force when the request ran, so past rows keep
          their historical basis.
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Breakdown by</h2>
          <select
            value={dim}
            onChange={(e) => {
              setDim(e.target.value as Dim);
              setExpanded(null);
            }}
            style={{ width: 200 }}
            data-testid="cost-dimension"
          >
            {(Object.keys(DIM_LABEL) as Dim[]).map((d) => (
              <option key={d} value={d}>
                {DIM_LABEL[d]}
              </option>
            ))}
          </select>
          <span className="sub">click a row to see what it breaks into</span>
        </div>

        <table>
          <thead>
            <tr>
              <th>{DIM_LABEL[dim]}</th>
              <th></th>
              <th className="num">Requests</th>
              <th className="num">Tokens in / out</th>
              <th className="num">Cost</th>
              <th className="num">Share</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map((g) => {
              const isOpen = expanded === g.key;
              const share = total.costCents > 0 ? (g.totals.costCents / total.costCents) * 100 : 0;
              return [
                <tr
                  key={g.key}
                  onClick={() => setExpanded(isOpen ? null : g.key)}
                  style={{ cursor: 'pointer' }}
                  data-testid={`cost-row-${g.key}`}
                >
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
                    <span style={{ color: 'var(--ink-soft)', marginRight: 6 }}>{isOpen ? '▾' : '▸'}</span>
                    {g.key}
                    {g.totals.costUnknownCount > 0 && (
                      <span className="chip" style={{ marginLeft: 6 }} title="Some requests ran on an unpriced model — cost incomplete">
                        {g.totals.costUnknownCount} unpriced
                      </span>
                    )}
                  </td>
                  <td style={{ width: '22%' }}>
                    <div className="track" style={{ height: 6 }}>
                      <div className="fill" style={{ width: `${(g.totals.costCents / maxCost) * 100}%` }} />
                    </div>
                  </td>
                  <td className="num">{g.totals.requests.toLocaleString()}</td>
                  <td className="num">
                    {fmtTokens(g.totals.promptTokens)} / {fmtTokens(g.totals.completionTokens)}
                  </td>
                  <td className="num">{fmtCost(g.totals.costCents)}</td>
                  <td className="num">{share.toFixed(1)}%</td>
                </tr>,
                isOpen && (
                  <tr key={`${g.key}-detail`}>
                    <td colSpan={6} style={{ background: 'var(--bg-soft, rgba(127,127,127,0.06))' }}>
                      <div className="row" style={{ gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                        {OTHERS[dim].map((sub) => (
                          <SubBreakdown
                            key={sub}
                            label={DIM_LABEL[sub]}
                            rows={groupBy(
                              (rows ?? []).filter((r) => r[dim] === g.key),
                              sub,
                            )}
                          />
                        ))}
                      </div>
                    </td>
                  </tr>
                ),
              ];
            })}
            {rows !== null && grouped.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <div className="empty">
                    <div className="big">No AI spend in this period</div>
                    Local-tier traffic is free and still appears here with $0 once requests are served.
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SubBreakdown({ label, rows }: { label: string; rows: { key: string; totals: Totals }[] }): JSX.Element {
  const max = Math.max(1e-9, ...rows.map((r) => r.totals.costCents));
  return (
    <div style={{ minWidth: 280, flex: 1 }}>
      <label style={{ marginTop: 4 }}>{label}</label>
      {rows.map((r) => (
        <div className="bar" key={r.key}>
          <span className="lbl" title={r.key} style={{ fontSize: 12 }}>
            {r.key}
          </span>
          <div className="track">
            <div className="fill" style={{ width: `${(r.totals.costCents / max) * 100}%` }} />
          </div>
          <span className="amt">
            {fmtCost(r.totals.costCents)}
            <span style={{ color: 'var(--ink-soft)' }}> · {r.totals.requests.toLocaleString()}×</span>
          </span>
        </div>
      ))}
    </div>
  );
}
