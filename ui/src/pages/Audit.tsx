import { useEffect, useState } from 'react';
import { api, mounted, type AuditRow } from '../api';

/** Live request log (11.8): recent audit events, metadata only, 5s polling. */
export function Audit(): JSX.Element {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [event, setEvent] = useState('');
  const [live, setLive] = useState(true);

  useEffect(() => {
    const load = (): void => {
      const params = new URLSearchParams({ limit: '100' });
      if (event) params.set('event', event);
      void api.get<AuditRow[]>(`/admin-api/audit?${params}`).then(setRows);
    };
    load();
    if (!live) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [event, live]);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Audit log</h1>
          <p className="sub">Every routing decision — metadata and hashes only; prompt bodies are never stored.</p>
        </div>
        <div className="row">
          <select value={event} onChange={(e) => setEvent(e.target.value)} style={{ width: 220 }}>
            <option value="">all events</option>
            {['request', 'blocked_scrubber', 'blocked_policy', 'provider_error', 'fallback_hop',
              'config_change', 'budget_soft_warning', 'rate_limited', 'model_deprecation_warning'].map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
          <button onClick={() => setLive(!live)}>{live ? 'Pause' : 'Resume'} live</button>
          <a className="btn" href={mounted('/admin-api/audit.csv')} download>Export CSV</a>
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Event</th>
              <th>App</th>
              <th>Task class</th>
              <th>Model</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>{new Date(r.ts).toLocaleTimeString()}</td>
                <td>
                  <span
                    className="chip"
                    style={
                      r.event.startsWith('blocked') || r.event === 'provider_error'
                        ? { color: 'var(--red)', borderColor: 'var(--red)', background: 'var(--red-soft)' }
                        : {}
                    }
                  >
                    {r.event}
                  </span>
                </td>
                <td>{r.app ?? '—'}</td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.taskClass ?? '—'}</td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.model ?? '—'}</td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink-soft)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {JSON.stringify(r.detail)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <div className="empty">
                    <div className="big">Nothing logged yet</div>
                    Events appear here the moment traffic or configuration changes happen.
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
