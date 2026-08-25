import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

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

      <AdminAccount />
    </>
  );
}

/**
 * Change the logged-in admin's email/password. The server requires the current password and
 * destroys every session on success (including this one), so the page reloads to the login
 * form. Lockout recovery: re-running bootstrap-firm re-applies the appliance env credentials.
 */
function AdminAccount(): JSX.Element {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setError('');
    if (!newEmail && !newPassword) {
      setError('Enter a new email, a new password, or both.');
      return;
    }
    if (newPassword && newPassword !== confirm) {
      setError('New password and confirmation do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/admin-api/auth/change-credentials', {
        currentPassword,
        ...(newEmail ? { newEmail } : {}),
        ...(newPassword ? { newPassword } : {}),
      });
      setDone(true);
      window.setTimeout(() => window.location.reload(), 1500); // sessions are gone — back to login
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'change failed');
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Admin account</h2>
      <p className="sub">
        Change the login for this admin console. All sessions are signed out on success — you’ll
        log back in with the new credentials. (Locked out? Re-running the appliance bootstrap
        restores the provisioned login.)
      </p>
      {done ? (
        <div className="notice" data-testid="account-changed">Credentials changed — redirecting to login…</div>
      ) : (
        <>
          <label>Current password (required)</label>
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            style={{ width: 320 }}
          />
          <div className="row">
            <div>
              <label>New email (blank = keep)</label>
              <input
                type="email"
                autoComplete="username"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                style={{ width: 320 }}
              />
            </div>
          </div>
          <div className="row">
            <div>
              <label>New password (blank = keep, min 12 chars)</label>
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                style={{ width: 320 }}
              />
            </div>
            <div>
              <label>Confirm new password</label>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                style={{ width: 320 }}
              />
            </div>
          </div>
          {error && <div className="error" data-testid="account-error">{error}</div>}
          <button
            className="primary"
            onClick={() => void submit()}
            disabled={busy || !currentPassword}
            data-testid="account-save"
            style={{ marginTop: 10 }}
          >
            {busy ? 'Changing…' : 'Change credentials'}
          </button>
        </>
      )}
    </div>
  );
}
