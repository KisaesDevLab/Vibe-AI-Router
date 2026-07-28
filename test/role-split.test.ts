/**
 * ROUTER_ROLE surface separation. The whole point of the split is that the console can be
 * published over TLS without publishing the gateway alongside it — so a console process must
 * NOT answer /v1, and a gateway process must NOT answer /admin-api. Anything weaker and the
 * public vhost re-exposes the surface we split off.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { NoopLedger } from '../src/gateway/pipeline.js';
import { StubAdapter } from '../src/gateway/stub-adapter.js';
import { createLogger } from '../src/lib/logger.js';
import { SessionStore } from '../src/admin-api/session.js';
import { Metrics } from '../src/ops/metrics.js';
import { resetDb } from './helpers.js';
import { DEMO } from '../db/seed.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

describe.skipIf(!url)('ROUTER_ROLE surface separation', () => {
  let handle: DbHandle;
  const apps: FastifyInstance[] = [];

  const build = (role: 'gateway' | 'console' | 'both'): FastifyInstance => {
    const app = buildApp({
      env: loadEnv({ DATABASE_URL: url as string, NODE_ENV: 'test', ROUTER_ROLE: role }),
      gateway: {
        deps: {
          db: handle.db,
          adapters: { forKind: () => new StubAdapter('role split reply') },
          ledger: new NoopLedger(),
          log: createLogger('silent', false),
          engine: new PolicyEngine(handle.db, 50),
          metrics: new Metrics(() => []),
        },
      },
      adminApi: {
        sessions: new SessionStore('role-split-secret'),
        secureCookies: false,
        adapterFor: () => undefined,
      },
    });
    apps.push(app);
    return app;
  };

  beforeAll(async () => {
    await resetDb(url as string);
    handle = createDb(url as string, 3);
  });

  afterAll(async () => {
    for (const a of apps) await a.close();
    await handle?.close();
  });

  const chat = (app: FastifyInstance): Promise<{ statusCode: number }> =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': 'tb_classification',
      },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });

  it('gateway role: serves /v1, refuses every console surface', async () => {
    const app = build('gateway');
    expect((await chat(app)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
    expect(((await app.inject({ method: 'GET', url: '/role' })).json() as { role: string }).role).toBe(
      'gateway',
    );

    for (const path of [
      '/admin-api/auth/me',
      '/admin-api/providers',
      '/admin-api/settings',
      '/admin-api/app-tokens',
    ]) {
      expect((await app.inject({ method: 'GET', url: path })).statusCode, path).toBe(404);
    }
    // login must not exist either — otherwise the gateway is an auth surface too
    const login = await app.inject({
      method: 'POST',
      url: '/admin-api/auth/login',
      headers: { 'content-type': 'application/json', 'x-vibe-admin': '1' },
      payload: { email: DEMO.adminEmail, password: DEMO.adminPassword },
    });
    expect(login.statusCode).toBe(404);
    // and no SPA shell is served from a gateway container
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  });

  it('console role: serves the admin surface, refuses /v1 with JSON (never the SPA shell)', async () => {
    const app = build('console');
    const login = await app.inject({
      method: 'POST',
      url: '/admin-api/auth/login',
      headers: { 'content-type': 'application/json', 'x-vibe-admin': '1' },
      payload: { email: DEMO.adminEmail, password: DEMO.adminPassword },
    });
    expect(login.statusCode).toBe(200);
    expect(((await app.inject({ method: 'GET', url: '/role' })).json() as { role: string }).role).toBe(
      'console',
    );

    // THE POINT OF THE SPLIT: no gateway on the publicly-routed container
    const res = await chat(app);
    expect(res.statusCode).toBe(404);

    for (const path of ['/v1/chat/completions', '/v1/billing/usage?period=202607', '/v1/task-classes/register']) {
      const r = await app.inject({ method: 'GET', url: path });
      expect(r.statusCode, path).toBe(404);
      // JSON, not the SPA — a 200 HTML shell would read as success to a caller
      expect(r.headers['content-type'], path).toContain('application/json');
    }

    // /metrics is unauthenticated operational data (task-class counts, provider names,
    // breaker state). The console gets a Caddy vhost, so it must not carry the endpoint —
    // the appliance also blocks it at the edge (deny_paths), but the container itself is
    // the last line. Found by Kurt in appliance integration.
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
  });

  it('both role (dev/default): serves everything, preserving the pre-split shape', async () => {
    const app = build('both');
    expect((await chat(app)).statusCode).toBe(200);
    const login = await app.inject({
      method: 'POST',
      url: '/admin-api/auth/login',
      headers: { 'content-type': 'application/json', 'x-vibe-admin': '1' },
      payload: { email: DEMO.adminEmail, password: DEMO.adminPassword },
    });
    expect(login.statusCode).toBe(200);
  });
});
