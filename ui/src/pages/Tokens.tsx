import { useEffect, useState } from 'react';
import { api } from '../api';

interface TokenRow {
  id: string;
  app: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function Tokens(): JSX.Element {
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [app, setApp] = useState('');
  const [minted, setMinted] = useState('');

  const reload = (): void => {
    void api.get<TokenRow[]>('/admin-api/app-tokens').then(setRows);
  };
  useEffect(reload, []);

  const mint = async (): Promise<void> => {
    const res = await api.post<{ token: string }>('/admin-api/app-tokens', { app });
    setMinted(res.token);
    setApp('');
    reload();
  };

  return (
    <>
      <h1>App tokens</h1>
      <p className="sub">How Vibe apps authenticate to the router. Tokens are hashed — shown exactly once at mint.</p>

      <div className="card">
        <div className="row">
          <input
            className="grow"
            placeholder="App id, e.g. vibe-tb"
            value={app}
            onChange={(e) => setApp(e.target.value)}
          />
          <button className="primary" onClick={() => void mint()} disabled={!app}>
            Mint token
          </button>
        </div>
        {minted && (
          <div className="notice" style={{ fontFamily: 'var(--mono)', fontSize: 12.5, wordBreak: 'break-all' }}>
            Copy now — it will not be shown again: {minted}
          </div>
        )}
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>App</th>
              <th>Scopes</th>
              <th>Last used</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{t.app}</td>
                <td>{t.scopes.map((s) => <span key={s} className="chip" style={{ marginRight: 4 }}>{s}</span>)}</td>
                <td className="num">{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : 'never'}</td>
                <td>{t.revokedAt ? <span className="status down">REVOKED</span> : <span className="status healthy">ACTIVE</span>}</td>
                <td style={{ textAlign: 'right' }}>
                  {!t.revokedAt && (
                    <button className="danger" onClick={() => void api.post(`/admin-api/app-tokens/${t.id}/revoke`).then(reload)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
