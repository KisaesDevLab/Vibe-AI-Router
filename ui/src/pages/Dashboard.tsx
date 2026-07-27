import { useEffect, useState } from 'react';
import { api, fmtCents, type DashboardHealth, type SpendRow } from '../api';
import { Status } from '../components';

interface SpendResponse {
  by: string;
  spend: SpendRow[];
  latency: { p50Ms: number | null; p95Ms: number | null; requests: number };
}

export function Dashboard(): JSX.Element {
  const [by, setBy] = useState('day');
  const [spend, setSpend] = useState<SpendResponse | null>(null);
  const [health, setHealth] = useState<DashboardHealth | null>(null);
  const [testResult, setTestResult] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [taskClasses, setTaskClasses] = useState<{ key: string }[]>([]);
  const [testClass, setTestClass] = useState('');

  useEffect(() => {
    void api.get<SpendResponse>(`/admin-api/dashboard/spend?by=${by}`).then(setSpend);
  }, [by]);
  useEffect(() => {
    void api.get<DashboardHealth>('/admin-api/dashboard/health').then(setHealth);
    void api.get<{ key: string }[]>('/admin-api/task-classes').then((rows) => {
      setTaskClasses(rows);
      if (rows[0]) setTestClass(rows[0].key);
    });
  }, []);

  const totalCents = spend?.spend.reduce((s, r) => s + Number(r.costCents), 0) ?? 0;
  const totalReq = spend?.spend.reduce((s, r) => s + r.requests, 0) ?? 0;
  const maxCents = Math.max(1, ...(spend?.spend.map((r) => Number(r.costCents)) ?? [1]));

  const firmBudget = health?.budgets.settings.firm_monthly_cents;
  const firmSpent = Number(health?.budgets.state.find((s) => s.scope === 'firm')?.spentCents ?? 0);

  const runTest = async (): Promise<void> => {
    setTestBusy(true);
    setTestResult('');
    try {
      const res = await api.post<{ model: string; content: string; latencyMs: number }>(
        '/admin-api/test-prompt',
        { taskClass: testClass, content: 'Reply with one short sentence confirming you are reachable.' },
      );
      setTestResult(`✓ ${res.model} answered in ${res.latencyMs}ms: “${res.content.slice(0, 140)}”`);
    } catch (err) {
      setTestResult(`✗ ${err instanceof Error ? err.message : 'failed'}`);
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">AI spend, provider health, and the data boundary at a glance.</p>

      <div className="cards">
        <div className="stat">
          <div className="k">Spend (shown range)</div>
          <div className="v num">{fmtCents(totalCents)}</div>
        </div>
        <div className="stat">
          <div className="k">Requests</div>
          <div className="v num">{totalReq.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="k">Latency p50 / p95</div>
          <div className="v num">
            {spend?.latency.p50Ms != null ? Math.round(spend.latency.p50Ms) : '—'}
            <small> / {spend?.latency.p95Ms != null ? Math.round(spend.latency.p95Ms) : '—'} ms</small>
          </div>
        </div>
        {firmBudget !== undefined && (
          <div className="stat">
            <div className="k">Firm budget · {health?.budgets.period}</div>
            <div className="v num">
              {fmtCents(firmSpent)}
              <small> of {fmtCents(firmBudget)}</small>
            </div>
            <div className="gauge">
              <div className="track">
                <div
                  className={`fill ${firmSpent >= firmBudget ? 'over' : firmSpent >= firmBudget * 0.8 ? 'warn' : ''}`}
                  style={{ width: `${Math.min(100, (firmSpent / firmBudget) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Spend by</h2>
          <select value={by} onChange={(e) => setBy(e.target.value)} style={{ width: 140 }}>
            <option value="day">day</option>
            <option value="model">model</option>
            <option value="app">app</option>
            <option value="task_class">task class</option>
            <option value="client">client</option>
          </select>
        </div>
        {spend && spend.spend.length === 0 && (
          <div className="empty">
            <div className="big">No AI traffic yet</div>
            Send a test prompt below, or point a Vibe app at this router.
          </div>
        )}
        {spend?.spend.map((r) => (
          <div className="bar" key={r.dimension}>
            <span className="lbl" title={r.dimension}>{r.dimension}</span>
            <div className="track">
              <div className="fill" style={{ width: `${(Number(r.costCents) / maxCents) * 100}%` }} />
            </div>
            <span className="amt">
              {fmtCents(r.costCents)}
              {r.costUnknownCount > 0 ? ' ⚠' : ''}
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Provider health</h2>
        {health && health.providers.length === 0 && (
          <div className="empty">
            <div className="big">Running fully local</div>
            Add a cloud provider to enable cloud-tier task classes — nothing requires one.
          </div>
        )}
        {health && health.providers.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Breaker</th>
                <th>Last check</th>
              </tr>
            </thead>
            <tbody>
              {health.providers.map((p) => {
                const breaker = health.breakers.find((b) => b.providerId === p.id);
                return (
                  <tr key={p.id}>
                    <td>{p.label}</td>
                    <td><span className="chip">{p.kind}</span></td>
                    <td><Status value={p.status} /></td>
                    <td className="num">{breaker ? `${breaker.state} (${Math.round(breaker.errorRate * 100)}%)` : 'closed'}</td>
                    <td className="num">{p.lastHealthAt ? new Date(p.lastHealthAt).toLocaleString() : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Send a test prompt</h2>
        <div className="row">
          <select
            value={testClass}
            onChange={(e) => setTestClass(e.target.value)}
            style={{ width: 260 }}
            data-testid="test-class"
          >
            {taskClasses.map((c) => (
              <option key={c.key} value={c.key}>{c.key}</option>
            ))}
          </select>
          <button className="primary" onClick={() => void runTest()} disabled={testBusy || !testClass}>
            {testBusy ? 'Sending…' : 'Send test prompt'}
          </button>
        </div>
        {testResult && <div className={testResult.startsWith('✓') ? 'notice' : 'error'} data-testid="test-result">{testResult}</div>}
      </div>
    </>
  );
}
