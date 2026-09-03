import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Model, type ProbeResponse, type ScrapeReport } from '../api';
import { Caps } from '../components';

type SortKey = 'model' | 'ctx' | 'in' | 'out' | 'status' | 'kind';

export function Catalog(): JSX.Element {
  const [models, setModels] = useState<Model[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [capability, setCapability] = useState('');
  const [source, setSource] = useState('');
  // default ON: "models you can actually route to" is the working view; the toggle reveals the rest
  const [configuredOnly, setConfiguredOnly] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('model');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Model | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scraping, setScraping] = useState(false);

  const reload = (): void => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    void api.get<Model[]>(`/admin-api/models?${params}`).then(setModels);
  };
  useEffect(reload, [search, status]);

  const num = (v: string | null | undefined): number => (v == null ? -1 : Number(v));
  const visible = useMemo(() => {
    const filtered = models.filter(
      (m) =>
        (!configuredOnly || m.configured) &&
        (!capability || m.effective[capability]) &&
        (!source || m.source === source),
    );
    const cmp = (a: Model, b: Model): number => {
      switch (sortKey) {
        case 'ctx': return a.contextWindow - b.contextWindow;
        case 'in': return num(a.pricing?.inputPerMtok) - num(b.pricing?.inputPerMtok);
        case 'out': return num(a.pricing?.outputPerMtok) - num(b.pricing?.outputPerMtok);
        case 'status': return a.status.localeCompare(b.status);
        case 'kind': return a.providerKind.localeCompare(b.providerKind) || a.canonicalId.localeCompare(b.canonicalId);
        default: return a.canonicalId.localeCompare(b.canonicalId);
      }
    };
    return [...filtered].sort((a, b) => sortDir * cmp(a, b));
  }, [models, configuredOnly, capability, source, sortKey, sortDir]);

  const sortBy = (key: SortKey): void => {
    if (key === sortKey) setSortDir(sortDir === 1 ? -1 : 1);
    else {
      setSortKey(key);
      setSortDir(1);
    }
  };
  const arrow = (key: SortKey): string => (key === sortKey ? (sortDir === 1 ? ' ▲' : ' ▼') : '');
  const Th = ({ k, children, right }: { k: SortKey; children: string; right?: boolean }): JSX.Element => (
    <th
      className={right ? 'num' : undefined}
      onClick={() => sortBy(k)}
      style={{ cursor: 'pointer', userSelect: 'none' }}
      title="Sort"
    >
      {children}
      {arrow(k)}
    </th>
  );

  const scrapeDocs = async (): Promise<void> => {
    setError('');
    setNotice('');
    setScraping(true);
    try {
      const r = await api.post<ScrapeReport>('/admin-api/catalog/scrape-docs');
      setNotice(
        `DO docs: ${r.scraped} models read — capabilities updated on ${r.capabilitiesUpdated.length}, ` +
          `specs on ${r.specsUpdated.length}, pricing on ${r.pricingChanged.length}` +
          (r.skippedCurated.length > 0 ? ` (${r.skippedCurated.length} curated rows left to the feed)` : ''),
      );
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'DO docs scrape failed');
    } finally {
      setScraping(false);
    }
  };

  const perMtok = (v: string | null | undefined): string =>
    v == null ? '—' : `$${Number(v).toFixed(Number(v) < 1 ? 2 : 0)}`;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Model catalog</h1>
          <p className="sub">Synced nightly from the vendored pricing feed; custom models are yours to manage.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button onClick={() => void scrapeDocs()} disabled={scraping} data-testid="scrape-docs" title="Pull published capabilities, context windows, and pricing from docs.digitalocean.com into discovered DigitalOcean models">
            {scraping ? 'Reading DO docs…' : 'Detect from DO docs'}
          </button>
          <button className="primary" onClick={() => setShowAdd(!showAdd)}>Add custom model</button>
        </div>
      </div>

      {showAdd && <AddModel onDone={() => { setShowAdd(false); reload(); }} onError={setError} />}
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice" data-testid="scrape-notice">{notice}</div>}

      <div className="card">
        <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
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
          <select value={capability} onChange={(e) => setCapability(e.target.value)} style={{ width: 150 }} data-testid="filter-capability">
            <option value="">any capability</option>
            <option value="tools">tools</option>
            <option value="json_schema">json_schema</option>
            <option value="vision">vision</option>
            <option value="caching">caching</option>
            <option value="reasoning">reasoning</option>
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)} style={{ width: 140 }} data-testid="filter-source">
            <option value="">any source</option>
            <option value="synced">synced</option>
            <option value="provider">discovered</option>
            <option value="custom">custom</option>
          </select>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', margin: 0 }} title="Only models whose provider kind the firm has configured — the ones requests can actually route to">
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={configuredOnly}
              onChange={(e) => setConfiguredOnly(e.target.checked)}
              data-testid="filter-configured"
            />
            <span style={{ fontSize: 12.5 }}>configured providers only</span>
          </label>
        </div>
        <table>
          <thead>
            <tr>
              <Th k="model">Model</Th>
              <Th k="kind">Kind</Th>
              <Th k="ctx" right>Ctx</Th>
              <th>Capabilities</th>
              <Th k="in" right>$/MTok in</Th>
              <Th k="out" right>$/MTok out</Th>
              <Th k="status">Status</Th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((m) => (
              <tr key={m.id}>
                <td>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{m.canonicalId}</span>
                  {m.source !== 'synced' && (
                    <span className="chip" style={{ marginLeft: 6 }}>{m.source === 'provider' ? 'discovered' : m.source}</span>
                  )}
                  {!m.configured && (
                    <span className="chip" style={{ marginLeft: 6 }} title="No provider of this kind is configured — requests cannot route here yet">
                      no provider
                    </span>
                  )}
                  {m.thirdPartyHosted && (
                    <span
                      className="chip"
                      style={{ marginLeft: 6 }}
                      title={m.retentionNote ?? 'Served by a third-party vendor through this provider; retention terms are the vendor’s'}
                      data-testid={`third-party-${m.canonicalId}`}
                    >
                      3rd-party hosted
                    </span>
                  )}
                </td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{m.providerKind}</td>
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
            {visible.length === 0 && (
              <tr>
                <td colSpan={8}>
                  <div className="empty">
                    <div className="big">No models match</div>
                    {configuredOnly && models.length > 0
                      ? 'Models exist but none belong to a configured provider — untick "configured providers only" to see the full catalog, or add a provider first.'
                      : 'Clear the search, or run a catalog sync from the ops runbook.'}
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
  const [probing, setProbing] = useState(false);
  const [probeNotes, setProbeNotes] = useState<string[]>([]);

  // live capability probe (Q-089): synthetic requests through the model's provider; the
  // verdicts pre-fill the checkboxes here and are written as overrides on Save
  const probe = async (): Promise<void> => {
    setError('');
    setProbing(true);
    setProbeNotes([]);
    try {
      const r = await api.post<ProbeResponse>(`/admin-api/models/${model.id}/probe`, { apply: false });
      const next = { ...caps };
      const notes: string[] = [];
      for (const res of r.results) {
        if (res.outcome === 'supported') next[res.capability] = true;
        else if (res.outcome === 'unsupported') next[res.capability] = false;
        notes.push(`${res.capability}: ${res.outcome}${res.outcome === 'inconclusive' ? ` (${res.detail})` : ''}`);
      }
      setCaps(next);
      setProbeNotes(notes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'probe failed');
    } finally {
      setProbing(false);
    }
  };

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

        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <label>Capabilities</label>
          <button
            onClick={() => void probe()}
            disabled={probing}
            data-testid="probe-capabilities"
            title="Send tiny synthetic test requests (a 1×1 image, a JSON-schema ask, a tool call) through this model's provider and set the checkboxes from what actually works"
          >
            {probing ? 'Probing…' : 'Probe live'}
          </button>
        </div>
        {probeNotes.length > 0 && (
          <p className="sub" style={{ marginTop: 2 }} data-testid="probe-result">
            Probe: {probeNotes.join(' · ')} — conclusive results are pre-ticked below; Save writes them as overrides.
          </p>
        )}
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
