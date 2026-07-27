import { useEffect, useState } from 'react';
import { api, ApiError, type Model } from '../api';
import { Caps } from '../components';

export function Catalog(): JSX.Element {
  const [models, setModels] = useState<Model[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState('');

  const reload = (): void => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    void api.get<Model[]>(`/admin-api/models?${params}`).then(setModels);
  };
  useEffect(reload, [search, status]);

  const perMtok = (v: string | null | undefined): string =>
    v == null ? '—' : `$${Number(v).toFixed(Number(v) < 1 ? 2 : 0)}`;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Model catalog</h1>
          <p className="sub">Synced nightly from the vendored pricing feed; custom models are yours to manage.</p>
        </div>
        <button className="primary" onClick={() => setShowAdd(!showAdd)}>Add custom model</button>
      </div>

      {showAdd && <AddModel onDone={() => { setShowAdd(false); reload(); }} onError={setError} />}
      {error && <div className="error">{error}</div>}

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <input
            className="grow"
            placeholder="Search models…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 140 }}>
            <option value="">all statuses</option>
            <option value="active">active</option>
            <option value="deprecated">deprecated</option>
            <option value="sunset">sunset</option>
          </select>
        </div>
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Ctx</th>
              <th>Capabilities</th>
              <th className="num">$/MTok in</th>
              <th className="num">$/MTok out</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{m.canonicalId}</span>
                  {m.source === 'custom' && <span className="chip" style={{ marginLeft: 6 }}>custom</span>}
                </td>
                <td className="num">{(m.contextWindow / 1000).toFixed(0)}k</td>
                <td><Caps caps={m.effective} /></td>
                <td className="num">{perMtok(m.pricing?.inputPerMtok)}</td>
                <td className="num">{perMtok(m.pricing?.outputPerMtok)}</td>
                <td>
                  {m.status === 'active' ? (
                    <span className="status healthy">ACTIVE</span>
                  ) : (
                    <span className="status degraded">{m.status.toUpperCase()}</span>
                  )}
                </td>
              </tr>
            ))}
            {models.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <div className="empty">
                    <div className="big">No models match</div>
                    Clear the search, or run a catalog sync from the ops runbook.
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

function AddModel({ onDone, onError }: { onDone: () => void; onError: (e: string) => void }): JSX.Element {
  const [form, setForm] = useState({
    canonicalId: 'ollama/',
    providerKind: 'local',
    displayName: '',
    contextWindow: 32768,
    tools: false,
    json_schema: false,
    vision: false,
  });

  const save = async (): Promise<void> => {
    onError('');
    try {
      await api.post('/admin-api/models', {
        canonicalId: form.canonicalId,
        providerKind: form.providerKind,
        displayName: form.displayName || form.canonicalId,
        contextWindow: Number(form.contextWindow),
        capabilities: {
          ...(form.tools ? { tools: true } : {}),
          ...(form.json_schema ? { json_schema: true } : {}),
          ...(form.vision ? { vision: true } : {}),
        },
      });
      onDone();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'failed to add model');
    }
  };

  return (
    <div className="card">
      <h2>Add custom model</h2>
      <p className="sub">No pricing set → its usage is flagged “cost unknown”, never silently zero.</p>
      <div className="row">
        <div className="grow">
          <label>Canonical id (family/native-name)</label>
          <input value={form.canonicalId} onChange={(e) => setForm({ ...form, canonicalId: e.target.value })} />
        </div>
        <div>
          <label>Kind</label>
          <select value={form.providerKind} onChange={(e) => setForm({ ...form, providerKind: e.target.value })}>
            <option value="local">local</option>
            <option value="openai_compat">openai_compat</option>
            <option value="anthropic">anthropic</option>
          </select>
        </div>
        <div>
          <label>Context window</label>
          <input
            type="number"
            value={form.contextWindow}
            onChange={(e) => setForm({ ...form, contextWindow: Number(e.target.value) })}
            style={{ width: 120 }}
          />
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        {(['tools', 'json_schema', 'vision'] as const).map((cap) => (
          <label key={cap} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={form[cap]}
              onChange={(e) => setForm({ ...form, [cap]: e.target.checked })}
            />
            {cap}
          </label>
        ))}
        <button className="primary" onClick={() => void save()} style={{ marginLeft: 'auto' }}>
          Add model
        </button>
      </div>
    </div>
  );
}
