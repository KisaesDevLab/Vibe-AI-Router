import { useEffect, useState } from 'react';
import { api, type Me } from './api';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Providers } from './pages/Providers';
import { Catalog } from './pages/Catalog';
import { Policies } from './pages/Policies';
import { Settings } from './pages/Settings';
import { Audit } from './pages/Audit';
import { Tokens } from './pages/Tokens';

const PAGES = [
  ['dashboard', 'Dashboard'],
  ['providers', 'Providers'],
  ['catalog', 'Model catalog'],
  ['policies', 'Policies'],
  ['tokens', 'App tokens'],
  ['audit', 'Audit log'],
  ['settings', 'Firm settings'],
] as const;

type PageKey = (typeof PAGES)[number][0];

function useHashPage(): PageKey {
  const [page, setPage] = useState<PageKey>((location.hash.slice(1) as PageKey) || 'dashboard');
  useEffect(() => {
    const onHash = (): void => setPage((location.hash.slice(1) as PageKey) || 'dashboard');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return PAGES.some(([k]) => k === page) ? page : 'dashboard';
}

export function App(): JSX.Element {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = loading
  const [zeroCloud, setZeroCloud] = useState<boolean | undefined>(undefined);
  const page = useHashPage();

  useEffect(() => {
    api
      .get<Me>('/admin-api/auth/me')
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    if (!me) return;
    api
      .get<{ zeroCloud: boolean }>('/admin-api/dashboard/health')
      .then((h) => setZeroCloud(h.zeroCloud))
      .catch(() => {});
  }, [me, page]);

  if (me === undefined) return <div />;
  if (me === null) return <Login onLogin={setMe} />;

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          vibe-ai-router
          <small>AI egress control</small>
        </div>
        {PAGES.map(([key, label]) => (
          <a key={key} href={`#${key}`} className={page === key ? 'active' : ''}>
            {label}
          </a>
        ))}
        <div className="foot">
          <div style={{ marginBottom: 6 }}>{me.email}</div>
          <button
            onClick={() => {
              void api.post('/admin-api/auth/logout').then(() => setMe(null));
            }}
          >
            Sign out
          </button>
        </div>
      </nav>
      <div className="main">
        <div className="topbar">
          {zeroCloud !== undefined && (
            <span className={`lamp ${zeroCloud ? 'local' : 'cloud'}`} title="Data boundary status">
              <span className="dot" />
              {zeroCloud ? 'FULLY LOCAL — no cloud providers configured' : 'CLOUD PROVIDERS ACTIVE'}
            </span>
          )}
          <span className="firm">{me.firm}</span>
        </div>
        <div className="content">
          {page === 'dashboard' && <Dashboard />}
          {page === 'providers' && <Providers />}
          {page === 'catalog' && <Catalog />}
          {page === 'policies' && <Policies />}
          {page === 'tokens' && <Tokens />}
          {page === 'audit' && <Audit />}
          {page === 'settings' && <Settings />}
        </div>
      </div>
    </div>
  );
}
