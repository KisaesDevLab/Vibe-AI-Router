import { useEffect, useState } from 'react';
import { api } from '../api';

interface SettingsShape {
  scrubber_mode?: 'block' | 'redact' | 'warn';
  banned_provider_kinds?: string[];
  banned_model_patterns?: string[];
  global_temperature_max?: number | null;
  budgets?: { firm_monthly_cents?: number; soft_pct?: number };
}

export function Settings(): JSX.Element {
  const [settings, setSettings] = useState<SettingsShape>({});
  const [firm, setFirm] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    void api.get<{ name: string; settings: SettingsShape }>('/admin-api/settings').then((r) => {
      setFirm(r.name);
      setSettings(r.settings);
    });
  }, []);

  const save = async (): Promise<void> => {
    setSaved('');
    const body: SettingsShape = {
      scrubber_mode: settings.scrubber_mode ?? 'block',
      ...(settings.banned_model_patterns ? { banned_model_patterns: settings.banned_model_patterns } : {}),
      // null = explicit clear; omitting the key would keep the old value server-side
      global_temperature_max: settings.global_temperature_max ?? null,
      ...(settings.budgets ? { budgets: settings.budgets } : {}),
    };
    await api.put('/admin-api/settings', body);
    setSaved('Settings saved.');
  };

  return (
    <>
      <h1>Firm settings</h1>
      <p className="sub">{firm}</p>

      <div className="card">
        <h2>Data protection</h2>
        <label>Scrubber mode — applies to every cloud-bound request</label>
        <select
          value={settings.scrubber_mode ?? 'block'}
          onChange={(e) => setSettings({ ...settings, scrubber_mode: e.target.value as SettingsShape['scrubber_mode'] })}
          style={{ width: 320 }}
        >
          <option value="block">block — reject requests containing protected data (default)</option>
          <option value="redact">redact — replace matches with [TYPE] tokens, then send</option>
          <option value="warn">warn — send unmodified, record an audit warning</option>
        </select>

        <label>Banned model patterns (wildcards, one per line)</label>
        <textarea
          rows={3}
          placeholder={'e.g.\nopenai/*-preview\n*/experimental-*'}
          value={(settings.banned_model_patterns ?? []).join('\n')}
          onChange={(e) =>
            setSettings({
              ...settings,
              banned_model_patterns: e.target.value.split('\n').filter((l) => l.trim() !== ''),
            })
          }
        />

        <label>Global temperature cap (blank = none)</label>
        <input
          type="number"
          step="0.1"
          min="0"
          max="2"
          value={settings.global_temperature_max ?? ''}
          onChange={(e) =>
            setSettings({
              ...settings,
              ...(e.target.value === ''
                ? { global_temperature_max: undefined }
                : { global_temperature_max: Number(e.target.value) }),
            })
          }
          style={{ width: 120 }}
        />
      </div>

      <div className="card">
        <h2>Budgets</h2>
        <div className="row">
          <div>
            <label>Firm monthly budget ($, blank = none)</label>
            <input
              type="number"
              value={settings.budgets?.firm_monthly_cents != null ? settings.budgets.firm_monthly_cents / 100 : ''}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  budgets: {
                    ...settings.budgets,
                    ...(e.target.value === ''
                      ? { firm_monthly_cents: undefined }
                      : { firm_monthly_cents: Math.round(Number(e.target.value) * 100) }),
                  },
                })
              }
              style={{ width: 140 }}
            />
          </div>
          <div>
            <label>Soft warning at (%)</label>
            <input
              type="number"
              min={1}
              max={100}
              value={settings.budgets?.soft_pct ?? 80}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  budgets: { ...settings.budgets, soft_pct: Number(e.target.value) },
                })
              }
              style={{ width: 90 }}
            />
          </div>
        </div>
      </div>

      {saved && <div className="notice">{saved}</div>}
      <button className="primary" onClick={() => void save()}>Save settings</button>
    </>
  );
}
