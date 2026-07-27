import { useState } from 'react';
import { api, ApiError, type Me } from '../api';

export function Login({ onLogin }: { onLogin: (me: Me) => void }): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post<Me>('/admin-api/auth/login', { email, password });
      const me = await api.get<Me>('/admin-api/auth/me');
      onLogin(me);
    } catch (err) {
      setError(err instanceof ApiError ? 'Email or password is incorrect.' : 'Could not reach the router.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={(e) => void submit(e)}>
        <div className="brand">vibe-ai-router</div>
        <p className="sub">Sign in to manage AI routing for your firm.</p>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <div className="error">{error}</div>}
        <div style={{ marginTop: 16 }}>
          <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}
