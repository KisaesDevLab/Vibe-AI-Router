import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Model, type PolicyExport, type PolicyView, type TaskClass } from '../api';
import { Tier } from '../components';

export function Policies(): JSX.Element {
  const [data, setData] = useState<PolicyExport | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [editing, setEditing] = useState<string | null>(null);

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
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{tc.key}</div>
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
  // config-time gating preview: only capability-valid models are offered (11.5)
  const eligible = useMemo(() => {
    const req = taskClass.requires as { tools?: boolean; json_schema?: boolean; vision?: boolean };
    return models.filter((m) => {
      if (m.status !== 'active') return false;
      if (taskClass.sensitivity === 'local_only' && m.providerKind !== 'local') return false;
      if (req.tools && !m.effective['tools']) return false;
      if (req.json_schema && !m.effective['json_schema']) return false;
      if (req.vision && !m.effective['vision']) return false;
      return true;
    });
  }, [models, taskClass]);

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

  return (
    <div className="modal-back" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>{taskClass.key}</h2>
          <Tier tier={taskClass.sensitivity} />
        </div>
        <p className="sub">
          {taskClass.description || 'No description.'}{' '}
          {taskClass.sensitivity === 'local_only' && 'Only local models are offered — this class never leaves the appliance.'}
        </p>

        <label>Default model (capability-valid only)</label>
        <select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} data-testid="policy-default">
          {eligible.map((m) => (
            <option key={m.canonicalId} value={m.canonicalId}>
              {m.canonicalId}
            </option>
          ))}
        </select>

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
