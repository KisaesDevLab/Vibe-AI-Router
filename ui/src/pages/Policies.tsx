import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Model, type PolicyExport, type PolicyView, type TaskClass } from '../api';
import { Tier } from '../components';

export function Policies(): JSX.Element {
  const [data, setData] = useState<PolicyExport | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const reload = (): void => {
    void api.get<PolicyExport>('/admin-api/policies').then(setData);
    void api.get<Model[]>('/admin-api/models').then(setModels);
  };
  useEffect(reload, []);

  if (!data) return <div />;

  return (
    <>
      <h1>Policies</h1>
      <p className="sub">
        What each task class may use. The badge is the data boundary — it is enforced by the
        router on every request, not by this page.
      </p>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Task class</th>
              <th>Boundary</th>
              <th>Default model</th>
              <th>Fallbacks</th>
              <th className="num">Max tokens</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.taskClasses.map((tc) => {
              const policy = data.policies.find((p) => p.taskClassKey === tc.key);
              return (
                <tr key={tc.key}>
                  <td>
                    <button
                      onClick={() => setInfo(tc.key)}
                      data-testid={`info-${tc.key}`}
                      title="What does this task class do?"
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 12.5,
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        color: 'var(--ink)',
                        textDecoration: 'underline',
                        textDecorationStyle: 'dotted',
                        textUnderlineOffset: 3,
                      }}
                    >
                      {tc.key}
                    </button>
                    <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{tc.app}</div>
                  </td>
                  <td><Tier tier={tc.sensitivity} /></td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
                    {policy?.defaultModel ?? <span style={{ color: 'var(--red)' }}>unconfigured — requests blocked</span>}
                  </td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                    {policy?.fallbackChain.join(' → ') || '—'}
                  </td>
                  <td className="num">{policy?.maxTokensOverride ?? tc.defaultMaxTokens}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button onClick={() => setEditing(tc.key)} data-testid={`edit-${tc.key}`}>Edit</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {info && (
        <TaskClassInfo
          taskClass={data.taskClasses.find((t) => t.key === info)!}
          policy={data.policies.find((p) => p.taskClassKey === info)}
          onClose={() => setInfo(null)}
        />
      )}

      {editing && (
        <Editor
          taskClass={data.taskClasses.find((t) => t.key === editing)!}
          policy={data.policies.find((p) => p.taskClassKey === editing)}
          models={models}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

const TIER_EXPLANATIONS: Record<TaskClass['sensitivity'], string> = {
  local_only:
    'Requests never leave the appliance. Only local models (Ollama/vibellm) can serve this class — cloud egress is structurally impossible, including via fallbacks.',
  cloud_deidentified:
    'Requests may route to the firm’s configured cloud providers, but every cloud-bound request passes through the PII scrubber first. Local models remain available.',
  cloud_allowed:
    'Requests may route to the firm’s configured cloud providers using the firm’s own keys. The router still enforces policy, capability checks, and budgets on every request.',
};

function TaskClassInfo({
  taskClass,
  policy,
  onClose,
}: {
  taskClass: TaskClass;
  policy: PolicyView | undefined;
  onClose: () => void;
}): JSX.Element {
  const req = taskClass.requires as { tools?: boolean; json_schema?: boolean; vision?: boolean };
  const caps = (['tools', 'json_schema', 'vision'] as const).filter((c) => req[c]);

  return (
    <div className="modal-back" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 16 }}>{taskClass.key}</h2>
          <Tier tier={taskClass.sensitivity} />
        </div>
        <p className="sub" style={{ marginTop: 0 }}>
          Declared by <strong>{taskClass.app}</strong>
        </p>

        <p>{taskClass.description || 'The app that declared this task class did not provide a description.'}</p>

        <label>Data boundary</label>
        <p className="sub" style={{ marginTop: 2 }}>{TIER_EXPLANATIONS[taskClass.sensitivity]}</p>

        <label>Required capabilities</label>
        <p className="sub" style={{ marginTop: 2 }}>
          {caps.length > 0
            ? `Models bound to this class must support: ${caps.join(', ')}. The router rejects both saving an incapable model here and any request that would reach one.`
            : 'None — any model permitted by the data boundary can serve it.'}
        </p>

        <label>Current routing</label>
        <p className="sub" style={{ marginTop: 2 }}>
          {policy?.defaultModel ? (
            <>
              Default model <span style={{ fontFamily: 'var(--mono)' }}>{policy.defaultModel}</span>
              {policy.fallbackChain.length > 0 && (
                <>
                  {' '}with fallback{policy.fallbackChain.length === 1 ? '' : 's'}{' '}
                  <span style={{ fontFamily: 'var(--mono)' }}>{policy.fallbackChain.join(' → ')}</span>
                </>
              )}
              . Up to {policy.maxTokensOverride ?? taskClass.defaultMaxTokens} tokens per response.
            </>
          ) : (
            'Unconfigured — requests naming this task class are blocked (fail closed) until a policy is saved.'
          )}
        </p>

        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose} data-testid="info-close">Close</button>
        </div>
      </div>
    </div>
  );
}

function Editor({
  taskClass,
  policy,
  models,
  onClose,
  onSaved,
}: {
  taskClass: TaskClass;
  policy: PolicyView | undefined;
  models: Model[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const req = taskClass.requires as { tools?: boolean; json_schema?: boolean; vision?: boolean };
  const localOnly = taskClass.sensitivity === 'local_only';
  const isLocalKind = (k: string): boolean => k === 'local' || k === 'local_ocr';

  // active models this class's DATA TIER permits (local tier = local + local_ocr, R4)
  const tierEligible = useMemo(
    () => models.filter((m) => m.status === 'active' && (!localOnly || isLocalKind(m.providerKind))),
    [models, localOnly],
  );
  // config-time gating preview: of the tier-permitted models, only capability-valid ones (11.5)
  const eligible = useMemo(
    () =>
      tierEligible.filter((m) => {
        if (req.tools && !m.effective['tools']) return false;
        if (req.json_schema && !m.effective['json_schema']) return false;
        if (req.vision && !m.effective['vision']) return false;
        return true;
      }),
    [tierEligible, req.tools, req.json_schema, req.vision],
  );
  // why models the operator might expect are not offered — surfaced below the picker
  const cloudHiddenByTier = useMemo(
    () => models.filter((m) => m.status === 'active' && !isLocalKind(m.providerKind)).length,
    [models],
  );
  const missingCaps = (['tools', 'json_schema', 'vision'] as const).filter((c) => req[c]);
  const hiddenByCapability = tierEligible.length - eligible.length;
  // per-model reasons, so "why isn't model X offered?" has a concrete, actionable answer
  const hiddenModels = useMemo(
    () =>
      models
        .filter((m) => m.status === 'active' && !eligible.some((e) => e.canonicalId === m.canonicalId))
        .map((m) => {
          if (localOnly && !isLocalKind(m.providerKind))
            return { id: m.canonicalId, reason: 'cloud model — this class is local_only' };
          const missing = missingCaps.filter((c) => !m.effective[c]);
          return {
            id: m.canonicalId,
            reason: `doesn't advertise ${missing.join(' + ')} — enable in Catalog → capability overrides if the model supports it`,
          };
        }),
    [models, eligible, localOnly, missingCaps],
  );

  const [defaultModel, setDefaultModel] = useState(policy?.defaultModel ?? eligible[0]?.canonicalId ?? '');
  const [allowed, setAllowed] = useState<string[]>(policy?.allowedModels ?? []);
  const [fallbacks, setFallbacks] = useState<string[]>(policy?.fallbackChain ?? []);
  const [maxTokens, setMaxTokens] = useState(policy?.maxTokensOverride ?? '');
  const [budget, setBudget] = useState(policy?.monthlyBudgetCents != null ? policy.monthlyBudgetCents / 100 : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await api.put(`/admin-api/policies/${taskClass.key}`, {
        defaultModel,
        allowedModels: allowed.includes(defaultModel) ? allowed : [defaultModel, ...allowed],
        fallbackChain: fallbacks,
        maxTokensOverride: maxTokens === '' ? null : Number(maxTokens),
        monthlyBudgetCents: budget === '' ? null : Math.round(Number(budget) * 100),
      });
      onSaved();
    } catch (err) {
      // inline validation from config-time gating (11.5)
      setError(err instanceof ApiError ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  };

  const move = (list: string[], idx: number, dir: -1 | 1): string[] => {
    const next = [...list];
    const [item] = next.splice(idx, 1);
    next.splice(idx + dir, 0, item!);
    return next;
  };

  // sensitivity is adjustable HERE, at the router (audited; registration never reverts it) —
  // widening a class is what lets its policy route to Anthropic/DigitalOcean/OpenAI models
  const changeTier = async (next: TaskClass['sensitivity']): Promise<void> => {
    if (next === taskClass.sensitivity) return;
    const widening =
      taskClass.sensitivity === 'local_only' ||
      (taskClass.sensitivity === 'cloud_deidentified' && next === 'cloud_allowed');
    const msg = widening
      ? `Widen ${taskClass.key} to ${next}? Cloud egress becomes possible for this class (the scrubber still applies to every cloud-bound request). The change is audited and affects the firm's "where your data goes" story.`
      : `Narrow ${taskClass.key} to ${next}? Cloud models in its current policy will stop validating and requests may fail closed until the policy is rebound.`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    setError('');
    try {
      await api.patch(`/admin-api/task-classes/${taskClass.key}`, { sensitivity: next });
      onSaved(); // close + reload so the model picker re-filters under the new tier
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'tier change failed');
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>{taskClass.key}</h2>
          <div className="row" style={{ gap: 8 }}>
            <Tier tier={taskClass.sensitivity} />
            <select
              value={taskClass.sensitivity}
              onChange={(e) => void changeTier(e.target.value as TaskClass['sensitivity'])}
              disabled={busy}
              data-testid="tier-select"
              title="Data tier — controls which provider kinds this class may route to"
            >
              <option value="local_only">local_only</option>
              <option value="cloud_deidentified">cloud_deidentified</option>
              <option value="cloud_allowed">cloud_allowed</option>
            </select>
          </div>
        </div>
        <p className="sub">
          {taskClass.description || 'No description.'}{' '}
          {taskClass.sensitivity === 'local_only' && 'Only local models are offered — this class never leaves the appliance. Widen the tier above to route it to cloud providers.'}
        </p>

        <label>Default model (capability-valid only)</label>
        <select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} data-testid="policy-default">
          {eligible.map((m) => (
            <option key={m.canonicalId} value={m.canonicalId}>
              {m.canonicalId}
            </option>
          ))}
        </select>
        {localOnly && cloudHiddenByTier > 0 && (
          <p className="sub" style={{ marginTop: 4 }}>
            {cloudHiddenByTier} cloud model{cloudHiddenByTier === 1 ? '' : 's'} (including any DigitalOcean) are
            hidden because this class is <strong>local_only</strong>. Widen the tier above to route to them.
          </p>
        )}
        {!localOnly && missingCaps.length > 0 && hiddenByCapability > 0 && (
          <p className="sub" style={{ marginTop: 4 }}>
            {hiddenByCapability} model{hiddenByCapability === 1 ? '' : 's'} hidden because they don't advertise{' '}
            <strong>{missingCaps.join(' + ')}</strong>. Enable it per model in{' '}
            <strong>Catalog → capability overrides</strong> after verifying the model supports it.
          </p>
        )}
        {hiddenModels.length > 0 && (
          <details style={{ marginTop: 6 }} data-testid="hidden-models">
            <summary className="sub" style={{ cursor: 'pointer' }}>
              {hiddenModels.length} active model{hiddenModels.length === 1 ? ' is' : 's are'} not offered — why?
            </summary>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {hiddenModels.map((h) => (
                <li key={h.id} style={{ fontSize: 12, marginBottom: 2 }}>
                  <span style={{ fontFamily: 'var(--mono)' }}>{h.id}</span>{' '}
                  <span style={{ color: 'var(--ink-soft)' }}>{h.reason}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <label>Also allowed (apps may request these)</label>
        <div className="row" style={{ gap: 6 }}>
          {eligible
            .filter((m) => m.canonicalId !== defaultModel)
            .map((m) => (
              <label key={m.canonicalId} style={{ display: 'inline-flex', gap: 5, alignItems: 'center', margin: 0 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={allowed.includes(m.canonicalId)}
                  onChange={(e) =>
                    setAllowed(
                      e.target.checked
                        ? [...allowed, m.canonicalId]
                        : allowed.filter((x) => x !== m.canonicalId),
                    )
                  }
                />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{m.canonicalId}</span>
              </label>
            ))}
        </div>

        <label>Fallback chain (tried in order when the default fails)</label>
        {fallbacks.map((f, i) => (
          <div className="row" key={`${f}-${i}`} style={{ marginBottom: 4 }}>
            <span className="grow" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
              {i + 1}. {f}
            </span>
            <button disabled={i === 0} onClick={() => setFallbacks(move(fallbacks, i, -1))}>↑</button>
            <button disabled={i === fallbacks.length - 1} onClick={() => setFallbacks(move(fallbacks, i, 1))}>↓</button>
            <button className="danger" onClick={() => setFallbacks(fallbacks.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) setFallbacks([...fallbacks, e.target.value]);
          }}
        >
          <option value="">+ add fallback…</option>
          {eligible
            .filter((m) => m.canonicalId !== defaultModel && !fallbacks.includes(m.canonicalId))
            .map((m) => (
              <option key={m.canonicalId} value={m.canonicalId}>
                {m.canonicalId}
              </option>
            ))}
        </select>

        <div className="row">
          <div>
            <label>Max tokens override</label>
            <input
              type="number"
              placeholder={String(taskClass.defaultMaxTokens)}
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value === '' ? '' : Number(e.target.value))}
              style={{ width: 140 }}
            />
          </div>
          <div>
            <label>Monthly budget ($, blank = none)</label>
            <input
              type="number"
              value={budget}
              onChange={(e) => setBudget(e.target.value === '' ? '' : Number(e.target.value))}
              style={{ width: 140 }}
            />
          </div>
        </div>

        {error && <div className="error" data-testid="policy-error">{error}</div>}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void save()} disabled={busy || !defaultModel} data-testid="policy-save">
            {busy ? 'Saving…' : 'Save policy'}
          </button>
        </div>
      </div>
    </div>
  );
}
