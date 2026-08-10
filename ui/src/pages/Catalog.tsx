import { useEffect, useState } from 'react';
import { api, ApiError, type Model } from '../api';
import { Caps } from '../components';

export function Catalog(): JSX.Element {
  const [models, setModels] = useState<Model[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Model | null>(null);
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
              <th></th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{m.canonicalId}</span>
                  {m.source !== 'synced' && (
                    <span className="chip" style={{ marginLeft: 6 }}>{m.source}</span>
                  )}
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
                <td style={{ textAlign: 'right' }}>
                  <button onClick={() => setEditing(m)} data-testid={`edit-model-${m.canonicalId}`}>Edit</button>
                </td>
              </tr>
            ))}
            {models.length === 0 && (
              <tr>
                <td colSpan={7}>
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

      {editing && (
        <EditModel
          model={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </>
  );
}

const CAP_KEYS = ['tools', 'json_schema', 'vision', 'caching', 'reasoning'] as const;

function EditModel({
  model,
  onClose,
  onSaved,
}: {
  model: Model;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  // synced rows are feed-managed: only capability overrides are editable (they survive re-sync)
  const feedManaged = model.source === 'synced';
  const [displayName, setDisplayName] = useState(model.displayName);
  const [contextWindow, setContextWindow] = useState<number | ''>(model.contextWindow);
  const [maxOutput, setMaxOutput] = useState<number | ''>(model.maxOutput ?? '');
  const [caps, setCaps] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(CAP_KEYS.map((k) => [k, !!model.effective[k]])),
  );
  const [priceIn, setPriceIn] = useState(model.pricing?.inputPerMtok ?? '');
  const [priceOut, setPriceOut] = useState(model.pricing?.outputPerMtok ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      // capabilities are sent for every source (written to overrides); base fields only when
      // the model is operator-owned, so the backend never rejects a synced base edit
      const patch: Record<string, unknown> = { capabilities: caps };
      if (!feedManaged) {
        if (displayName) patch['displayName'] = displayName;
        if (contextWindow !== '') patch['contextWindow'] = Number(contextWindow);
        patch['maxOutput'] = maxOutput === '' ? null : Number(maxOutput);
        if (priceIn !== '' && priceOut !== '') {
          patch['pricing'] = { inputPerMtok: Number(priceIn), outputPerMtok: Number(priceOut) };
        }
      }
      await api.patch(`/admin-api/models/${model.id}`, patch);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'save failed');
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 15 }}>{model.canonicalId}</h2>
          <span className="chip">{model.source}</span>
        </div>
        {feedManaged && (
          <p className="sub">
            This model is managed by the nightly pricing feed — its name, context window, and pricing come
            from there and would be overwritten on the next sync. Only <strong>capability overrides</strong>{' '}
            are editable here (they survive re-sync). To edit specs, add a custom model instead.
          </p>
        )}

        <label>Display name</label>
        <input value={displayName} disabled={feedManaged} onChange={(e) => setDisplayName(e.target.value)} />

        <div className="row">
          <div>
            <label>Context window</label>
            <input
              type="number"
              value={contextWindow}
              disabled={feedManaged}
              onChange={(e) => setContextWindow(e.target.value === '' ? '' : Number(e.target.value))}
              style={{ width: 140 }}
            />
          </div>
          <div>
            <label>Max output (blank = none)</label>
            <input
              type="number"
              value={maxOutput}
              disabled={feedManaged}
              onChange={(e) => setMaxOutput(e.target.value === '' ? '' : Number(e.target.value))}
              style={{ width: 140 }}
            />
          </div>
        </div>

        <label>Capabilities</label>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {CAP_KEYS.map((cap) => (
            <label key={cap} style={{ display: 'inline-flex', gap: 5, alignItems: 'center', margin: 0 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={!!caps[cap]}
                onChange={(e) => setCaps({ ...caps, [cap]: e.target.checked })}
              />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{cap}</span>
            </label>
          ))}
        </div>

        {!feedManaged && (
          <>
            <label>Pricing ($/MTok — set both, or leave blank for “cost unknown”)</label>
            <div className="row">
              <div>
                <span className="sub">input</span>
                <input
                  type="number"
                  value={priceIn}
                  onChange={(e) => setPriceIn(e.target.value)}
                  style={{ width: 140 }}
                />
              </div>
              <div>
                <span className="sub">output</span>
                <input
                  type="number"
                  value={priceOut}
                  onChange={(e) => setPriceOut(e.target.value)}
                  style={{ width: 140 }}
                />
              </div>
            </div>
          </>
        )}

        {error && <div className="error" data-testid="model-edit-error">{error}</div>}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void save()} disabled={busy} data-testid="model-edit-save">
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
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
            <option value="local_ocr">local_ocr (GLM-OCR)</option>
            <option value="openai_compat">openai_compat</option>
            <option value="anthropic">anthropic</option>
            <option value="digitalocean">digitalocean</option>
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
