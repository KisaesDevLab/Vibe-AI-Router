import { useEffect, useState } from 'react';
import { api, ApiError, type Provider } from '../api';
import { Status } from '../components';

const PRESETS: Record<string, { kind: string; baseUrl: string; authType: string }> = {
  OpenAI: { kind: 'openai_compat', baseUrl: 'https://api.openai.com/v1', authType: 'api_key' },
  'Azure OpenAI': { kind: 'openai_compat', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai?api-version=2024-10-21', authType: 'api_key' },
  Anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', authType: 'api_key' },
  'Ollama (local)': { kind: 'local', baseUrl: 'http://vibellm:11434/v1', authType: 'none' },
  Groq: { kind: 'openai_compat', baseUrl: 'https://api.groq.com/openai/v1', authType: 'api_key' },
  DeepSeek: { kind: 'openai_compat', baseUrl: 'https://api.deepseek.com/v1', authType: 'api_key' },
  // own kind (not openai_compat) so it routes independently next to OpenAI/Groq; the
  // credential is a DO "model access key", entered like any API key
  'DigitalOcean (Gradient)': { kind: 'digitalocean', baseUrl: 'https://inference.do-ai.run/v1', authType: 'api_key' },
};

export function Providers(): JSX.Element {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const reload = (): void => {
    void api.get<Provider[]>('/admin-api/providers').then(setProviders);
  };
  useEffect(reload, []);

  const test = async (p: Provider): Promise<void> => {
    setNotice(`Testing ${p.label}…`);
    try {
      const res = await api.post<{ ok: boolean; latencyMs: number; errorCode?: string }>(
        `/admin-api/providers/${p.id}/test`,
        {},
      );
      setNotice(res.ok ? `✓ ${p.label} reachable in ${res.latencyMs}ms` : `✗ ${p.label}: ${res.errorCode}`);
    } catch (err) {
      setNotice(`✗ ${p.label}: ${err instanceof Error ? err.message : 'test failed'}`);
    }
    reload();
  };

  const promote = async (credId: string): Promise<void> => {
    await api.post(`/admin-api/credentials/${credId}/promote`);
    reload();
  };
  const revoke = async (credId: string): Promise<void> => {
    await api.post(`/admin-api/credentials/${credId}/revoke`);
    reload();
  };
  const remove = async (p: Provider): Promise<void> => {
    if (!confirm(`Remove provider "${p.label}"? Policies pointing at its models will stop serving.`)) return;
    await api.del(`/admin-api/providers/${p.id}`);
    reload();
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Providers</h1>
          <p className="sub">Your firm's own AI endpoints and keys. Keys are write-only — they can never be read back.</p>
        </div>
        <button className="primary" onClick={() => setWizardOpen(true)} data-testid="add-provider">
          Add provider
        </button>
      </div>
      {notice && <div className={notice.startsWith('✗') ? 'error' : 'notice'}>{notice}</div>}

      {providers.length === 0 && (
        <div className="card empty">
          <div className="big">Running fully local</div>
          Every task class is served on-appliance. Add a cloud provider only if you want one —
          your keys stay encrypted here and cloud access remains policy-gated per task class.
        </div>
      )}

      {providers.map((p) => (
        <div className="card" key={p.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h2 style={{ marginBottom: 2 }}>{p.label}</h2>
              <span className="chip">{p.kind}</span>{' '}
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-soft)' }}>{p.baseUrl}</span>
            </div>
            <div className="row">
              <Status value={p.status} />
              <button onClick={() => void test(p)}>Test connection</button>
              <button className="danger" onClick={() => void remove(p)}>Remove</button>
            </div>
          </div>
          {p.authType === 'api_key' && (
            <CredentialPanel provider={p} onPromote={promote} onRevoke={revoke} onChanged={reload} />
          )}
        </div>
      ))}

      {wizardOpen && (
        <Wizard
          onClose={() => setWizardOpen(false)}
          onDone={() => {
            setWizardOpen(false);
            reload();
          }}
        />
      )}
    </>
  );
}

function CredentialPanel({
  provider,
  onPromote,
  onRevoke,
  onChanged,
}: {
  provider: Provider;
  onPromote: (id: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  onChanged: () => void;
}): JSX.Element {
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');

  const add = async (): Promise<void> => {
    setError('');
    try {
      await api.post(`/admin-api/providers/${provider.id}/credentials`, { apiKey: key });
      setKey('');
      setAdding(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to store key');
    }
  };

  return (
    <div style={{ marginTop: 12 }}>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Status</th>
            <th>Added</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {provider.credentials.map((c) => (
            <tr key={c.id}>
              <td className="num">····{c.last4}</td>
              <td>
                <span className="chip" style={{ textTransform: 'uppercase' }}>
                  {c.status === 'grace' && c.graceUntil === null ? 'staged' : c.status}
                </span>
              </td>
              <td className="num">{new Date(c.createdAt).toLocaleDateString()}</td>
              <td style={{ textAlign: 'right' }}>
                {c.status === 'grace' && c.graceUntil === null && (
                  <button onClick={() => void onPromote(c.id)}>Promote to active</button>
                )}{' '}
                {c.status !== 'revoked' && (
                  <button className="danger" onClick={() => void onRevoke(c.id)}>Revoke</button>
                )}
              </td>
            </tr>
          ))}
          {provider.credentials.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: 'var(--ink-soft)' }}>
                No key stored — requests to this provider will fail until one is added.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {adding ? (
        <div className="row" style={{ marginTop: 10 }}>
          <input
            className="grow"
            type="password"
            placeholder="Paste the API key — stored encrypted, shown never"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button className="primary" onClick={() => void add()} disabled={key.length < 8}>
            Store key
          </button>
          <button onClick={() => setAdding(false)}>Cancel</button>
        </div>
      ) : (
        <button style={{ marginTop: 10 }} onClick={() => setAdding(true)}>
          Add key
        </button>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** Provider setup wizard (11.3): preset → connection → key → live test → save. */
function Wizard({ onClose, onDone }: { onClose: () => void; onDone: () => void }): JSX.Element {
  const [step, setStep] = useState(0);
  const [preset, setPreset] = useState('OpenAI');
  const [label, setLabel] = useState('OpenAI');
  const [baseUrl, setBaseUrl] = useState(PRESETS['OpenAI']!.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [mapping, setMapping] = useState(''); // Azure: canonical=deployment lines
  const [testMsg, setTestMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const cfg = PRESETS[preset]!;
  const isAzure = preset === 'Azure OpenAI';
  const needsKey = cfg.authType === 'api_key';

  const finish = async (): Promise<void> => {
    setBusy(true);
    setError('');
    setTestMsg('');
    try {
      const modelMapping: Record<string, string> = {};
      for (const line of mapping.split('\n')) {
        const [k, v] = line.split('=').map((s) => s.trim());
        if (k && v) modelMapping[k] = v;
      }
      const provider = await api.post<{ id: string }>('/admin-api/providers', {
        kind: cfg.kind,
        label,
        baseUrl,
        authType: cfg.authType,
        modelMapping,
      });
      if (needsKey) {
        await api.post(`/admin-api/providers/${provider.id}/credentials`, { apiKey });
      }
      const test = await api.post<{ ok: boolean; latencyMs: number; errorCode?: string }>(
        `/admin-api/providers/${provider.id}/test`,
        {},
      );
      setTestMsg(
        test.ok
          ? `✓ Connected in ${test.latencyMs}ms — provider saved.`
          : `Provider saved, but the connection test failed (${test.errorCode}). Check the key or URL.`,
      );
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'setup failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" role="dialog" aria-modal="true">
      <div className="modal">
        <h2>Add provider</h2>
        <div className="steps">
          {['Kind', 'Connection', needsKey ? 'Key + test' : 'Test', 'Done'].map((s, i) => (
            <span key={s} className={i === step ? 'on' : ''}>{`${i + 1} ${s}`}</span>
          ))}
        </div>

        {step === 0 && (
          <>
            <label>Provider</label>
            <select
              value={preset}
              onChange={(e) => {
                setPreset(e.target.value);
                setLabel(e.target.value);
                setBaseUrl(PRESETS[e.target.value]!.baseUrl);
              }}
              data-testid="wizard-preset"
            >
              {Object.keys(PRESETS).map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={onClose}>Cancel</button>
              <button className="primary" onClick={() => setStep(1)}>Next</button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <label>Display name</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} data-testid="wizard-label" />
            <label>Base URL</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} data-testid="wizard-url" />
            {isAzure && (
              <>
                <label>Deployment mapping — one per line: canonical-id = deployment-name</label>
                <textarea
                  rows={3}
                  placeholder="azure/gpt-4o-mini = my-4o-mini-deployment"
                  value={mapping}
                  onChange={(e) => setMapping(e.target.value)}
                />
              </>
            )}
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => setStep(0)}>Back</button>
              <button className="primary" onClick={() => setStep(2)} disabled={!label || !baseUrl}>
                Next
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            {needsKey ? (
              <>
                <label>API key — encrypted on save; it can never be viewed again</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  data-testid="wizard-key"
                />
              </>
            ) : (
              <p className="sub">This endpoint needs no key. Save runs a live connection test.</p>
            )}
            {error && <div className="error">{error}</div>}
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => setStep(1)}>Back</button>
              <button
                className="primary"
                onClick={() => void finish()}
                disabled={busy || (needsKey && apiKey.length < 8)}
                data-testid="wizard-save"
              >
                {busy ? 'Testing…' : 'Save + test'}
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className={testMsg.startsWith('✓') ? 'notice' : 'notice amber'} data-testid="wizard-result">
              {testMsg}
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="primary" onClick={onDone}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
