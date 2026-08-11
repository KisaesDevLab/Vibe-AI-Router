/**
 * Catalog refresh on provider connection (Q-085): a successful connection test or a newly
 * stored credential triggers the model-catalog refresh hook (discovery + vendored sync in
 * production); a FAILED test must not. The hook is injected so the wiring is asserted without
 * running a full feed sync.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { NoopLedger } from '../src/gateway/pipeline.js';
import { StubAdapter } from '../src/gateway/stub-adapter.js';
import { createLogger } from '../src/lib/logger.js';
import { SessionStore } from '../src/admin-api/session.js';
import { CredentialVault } from '../src/vault/service.js';
import { keyringFromEnv } from '../src/vault/crypto.js';
import type { ConnectionTestResult, ProviderAdapter } from '../src/adapters/contract.js';
import { providers } from '../db/schema.js';
import { resetDb } from './helpers.js';
import { DEMO } from '../db/seed.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];
const MASTER = randomBytes(32).toString('base64');

describe.skipIf(!url)('catalog refresh on provider connection (Q-085)', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let base: string;
  let cookie: string;
  const refreshCalls: string[] = [];
  let nextTestResult: ConnectionTestResult = { ok: true, latencyMs: 1 };

  // the /test route only calls testConnection on the resolved adapter
  const fakeAdapter = {
    testConnection: () => Promise.resolve(nextTestResult),
  } as unknown as ProviderAdapter;

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 2);
    const keyring = keyringFromEnv({ MASTER_KEY: MASTER, MASTER_KEY_VERSION: 1 })!;
    const vault = new CredentialVault(handle.db, keyring, createLogger('silent', false), 24);
    app = buildApp({
      env: loadEnv({ DATABASE_URL: dbUrl, NODE_ENV: 'test' }),
      gateway: {
        deps: {
          db: handle.db,
          adapters: { forKind: () => new StubAdapter() },
          ledger: new NoopLedger(),
          log: createLogger('silent', false),
          engine: new PolicyEngine(handle.db),
        },
      },
      adminApi: {
        sessions: new SessionStore('refresh-test-secret'),
        secureCookies: false,
        vault,
        adapterFor: () => fakeAdapter,
        refreshCatalog: (reason: string) => refreshCalls.push(reason),
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;

    const login = await fetch(`${base}/admin-api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vibe-admin': '1' },
      body: JSON.stringify({ email: DEMO.adminEmail, password: DEMO.adminPassword }),
    });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  const post = (path: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-vibe-admin': '1' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  it('triggers a refresh on a successful test, none on a failed one, and on credential add', async () => {
    // keyless local provider — the /test route takes the authType 'none' path
    const created = await post('/admin-api/providers', {
      kind: 'local',
      label: 'Refresh Local',
      baseUrl: 'http://x/v1',
      authType: 'none',
    });
    expect(created.status).toBe(201);
    const { id: localId } = (await created.json()) as { id: string };
    expect(refreshCalls).toEqual([]); // creating alone is not a connection

    // failed test → NO refresh
    nextTestResult = { ok: false, latencyMs: 1, errorCode: 'auth_error' };
    expect((await post(`/admin-api/providers/${localId}/test`, {})).status).toBe(200);
    expect(refreshCalls).toEqual([]);

    // successful test → refresh
    nextTestResult = { ok: true, latencyMs: 1 };
    expect((await post(`/admin-api/providers/${localId}/test`, {})).status).toBe(200);
    expect(refreshCalls).toEqual(['test:Refresh Local']);

    // storing a credential (key makes the API reachable) → refresh. Provider inserted
    // directly: the config-time SSRF gate does live DNS for cloud kinds, and this test must
    // not depend on the network.
    const firm = await handle.db.query.firms.findFirst();
    const [doRow] = await handle.db
      .insert(providers)
      .values({
        firmId: firm!.id,
        kind: 'digitalocean',
        label: 'Refresh DO',
        baseUrl: 'https://inference.do-ai.run/v1',
        authType: 'api_key',
      })
      .returning();
    const doId = doRow!.id;
    const cred = await post(`/admin-api/providers/${doId}/credentials`, {
      apiKey: 'sk-do-refresh-test-key-1234',
    });
    expect(cred.status).toBe(201);
    expect(refreshCalls).toEqual(['test:Refresh Local', 'credential:Refresh DO']);

    // vault-path test (api_key provider) on success → refresh
    expect((await post(`/admin-api/providers/${doId}/test`, {})).status).toBe(200);
    expect(refreshCalls).toEqual(['test:Refresh Local', 'credential:Refresh DO', 'test:Refresh DO']);
  });
});
