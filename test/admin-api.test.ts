/**
 * Admin API auth surface (11.1): login, session guard, CSRF header requirement, and the
 * write-only credential rule at the admin layer.
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
import { hashPassword, verifyPassword } from '../src/lib/password.js';
import { resetDb } from './helpers.js';
import { DEMO } from '../db/seed.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

describe('password hashing', () => {
  it('round-trips and rejects wrong passwords + malformed hashes', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe.skipIf(!url)('admin api auth', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let base: string;

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 2);
    const deps = {
      db: handle.db,
      adapters: { forKind: () => new StubAdapter() },
      ledger: new NoopLedger(),
      log: createLogger('silent', false),
      engine: new PolicyEngine(handle.db),
    };
    app = buildApp({
      env: loadEnv({ DATABASE_URL: dbUrl, NODE_ENV: 'test' }),
      gateway: { deps },
      adminApi: {
        sessions: new SessionStore('test-session-secret'),
        secureCookies: false,
        adapterFor: () => undefined,
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  const login = async (password: string): Promise<Response> =>
    fetch(`${base}/admin-api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vibe-admin': '1' },
      body: JSON.stringify({ email: DEMO.adminEmail, password }),
    });

  it('rejects bad credentials, accepts seeded admin, session cookie works', async () => {
    expect((await login('nope-wrong')).status).toBe(401);

    const ok = await login(DEMO.adminPassword);
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const sess = cookie.split(';')[0]!;

    const me = await fetch(`${base}/admin-api/auth/me`, { headers: { cookie: sess } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe(DEMO.adminEmail);

    // guarded GET without session → 401
    expect((await fetch(`${base}/admin-api/providers`)).status).toBe(401);
    // guarded GET with session → 200
    expect((await fetch(`${base}/admin-api/providers`, { headers: { cookie: sess } })).status).toBe(200);

    // mutation WITHOUT the x-vibe-admin header → 403 (CSRF belt)
    const noHeader = await fetch(`${base}/admin-api/providers`, {
      method: 'POST',
      headers: { cookie: sess, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'local', label: 'X', baseUrl: 'http://x/v1', authType: 'none' }),
    });
    expect(noHeader.status).toBe(403);

    // with the header → created
    const withHeader = await fetch(`${base}/admin-api/providers`, {
      method: 'POST',
      headers: { cookie: sess, 'content-type': 'application/json', 'x-vibe-admin': '1' },
      body: JSON.stringify({ kind: 'local', label: 'X', baseUrl: 'http://x/v1', authType: 'none' }),
    });
    expect(withHeader.status).toBe(201);

    // tampered session signature rejected
    const tampered = await fetch(`${base}/admin-api/providers`, {
      headers: { cookie: `${sess}x` },
    });
    expect(tampered.status).toBe(401);

    // credential listing metadata-only guarantee is enforced by the vault layer (Phase 6 tests);
    // here: credentials on providers listing must never include ciphertext fields
    const providers = (await (
      await fetch(`${base}/admin-api/providers`, { headers: { cookie: sess } })
    ).json()) as Record<string, unknown>[];
    expect(JSON.stringify(providers)).not.toContain('ciphertext');
  });

  // runs LAST in this suite: on success every session for the admin is destroyed
  it('change-credentials: requires the current password, rotates login, kills sessions', async () => {
    const sess = (await login(DEMO.adminPassword)).headers.get('set-cookie')!.split(';')[0]!;
    const change = (body: unknown, cookie = sess): Promise<Response> =>
      fetch(`${base}/admin-api/auth/change-credentials`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-vibe-admin': '1' },
        body: JSON.stringify(body),
      });

    // a live session alone is NOT enough — the current password is re-verified
    expect((await change({ currentPassword: 'wrong', newPassword: 'longenough-pass-1' })).status).toBe(401);
    // nothing-to-change and too-short passwords are rejected up front
    expect((await change({ currentPassword: DEMO.adminPassword })).status).toBe(400);
    expect((await change({ currentPassword: DEMO.adminPassword, newPassword: 'short' })).status).toBe(400);

    const ok = await change({
      currentPassword: DEMO.adminPassword,
      newEmail: 'rotated-admin@example.test',
      newPassword: 'a-brand-new-admin-pass',
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { reauth: boolean }).reauth).toBe(true);
    // the cookie that made the change is dead too
    expect((await fetch(`${base}/admin-api/providers`, { headers: { cookie: sess } })).status).toBe(401);
    // old credentials no longer log in; the new pair does
    expect((await login(DEMO.adminPassword)).status).toBe(401);
    const relogin = await fetch(`${base}/admin-api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vibe-admin': '1' },
      body: JSON.stringify({ email: 'rotated-admin@example.test', password: 'a-brand-new-admin-pass' }),
    });
    expect(relogin.status).toBe(200);
  });
});
