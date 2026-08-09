/**
 * QA Round D — security pass on the admin + auth surface (threat model T1/T2/T4/T5/T6).
 * Every check here is an attack attempt that MUST fail, or a leak check that must come up
 * empty. Findings recorded in QA-REPORT.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { NoopLedger } from '../src/gateway/pipeline.js';
import { StubAdapter } from '../src/gateway/stub-adapter.js';
import { createLogger } from '../src/lib/logger.js';
import { SessionStore } from '../src/admin-api/session.js';
import { hashPassword } from '../src/lib/password.js';
import { CredentialVault } from '../src/vault/service.js';
import { keyringFromEnv } from '../src/vault/crypto.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { appTokens, firms, providers, users } from '../db/schema.js';
import { resetDb } from './helpers.js';
import { DEMO } from '../db/seed.js';
import { randomBytes } from 'node:crypto';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];
const MASTER = randomBytes(32).toString('base64');

describe.skipIf(!url)('QA-D: admin surface security', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let base: string;
  let adminCookie: string;
  let staffCookie: string;
  let firmId: string;
  let providerId: string;
  const SECRET_KEY = 'sk-live-qa-round-d-secret-key-9999';

  const login = async (email: string, password: string): Promise<Response> =>
    fetch(`${base}/admin-api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vibe-admin': '1' },
      body: JSON.stringify({ email, password }),
    });

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 4);
    firmId = (await handle.db.query.firms.findFirst())!.id;

    // a NON-admin user who can legitimately log in — privilege-escalation probe subject
    await handle.db.insert(users).values({
      firmId,
      role: 'staff',
      email: 'staff@demo.firm',
      displayName: 'Staff User',
      passwordHash: await hashPassword('staff-password-123'),
    });

    const keyring = keyringFromEnv({ MASTER_KEY: MASTER, MASTER_KEY_VERSION: 1 })!;
    const vault = new CredentialVault(handle.db, keyring, createLogger('silent', false), 24);
    const [cloud] = await handle.db
      .insert(providers)
      .values({
        firmId,
        kind: 'anthropic',
        label: 'QA-D Anthropic',
        baseUrl: 'https://api.anthropic.com',
        authType: 'api_key',
      })
      .returning();
    providerId = cloud!.id;
    await vault.add(providerId, SECRET_KEY);

    app = buildApp({
      env: loadEnv({ DATABASE_URL: dbUrl, NODE_ENV: 'test' }),
      gateway: {
        deps: {
          db: handle.db,
          adapters: { forKind: () => new StubAdapter() },
          ledger: new NoopLedger(),
          log: createLogger('silent', false),
          engine: new PolicyEngine(handle.db, 50),
        },
      },
      adminApi: {
        sessions: new SessionStore('qa-round-d-secret'),
        secureCookies: false,
        vault,
        adapterFor: (kind: string) => createAdapterRegistry().get(kind),
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;

    const adminRes = await login(DEMO.adminEmail, DEMO.adminPassword);
    adminCookie = (adminRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const staffRes = await login('staff@demo.firm', 'staff-password-123');
    staffCookie = (staffRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  // ── T4: authorization ─────────────────────────────────────────────────────
  it('non-admin role holds a valid session but cannot touch ANY admin endpoint', async () => {
    expect(staffCookie).not.toBe(''); // staff CAN authenticate…
    const me = await fetch(`${base}/admin-api/auth/me`, { headers: { cookie: staffCookie } });
    expect(me.status).toBe(200);

    // …but every admin surface must reject the staff session
    const guarded: [string, string][] = [
      ['GET', '/admin-api/providers'],
      ['GET', '/admin-api/models'],
      ['GET', '/admin-api/task-classes'],
      ['GET', '/admin-api/policies'],
      ['GET', '/admin-api/settings'],
      ['GET', '/admin-api/dashboard/spend'],
      ['GET', '/admin-api/dashboard/health'],
      ['GET', '/admin-api/audit'],
      ['GET', '/admin-api/audit.csv'],
      ['GET', '/admin-api/ledger.csv'],
      ['GET', '/admin-api/app-tokens'],
    ];
    for (const [method, path] of guarded) {
      const res = await fetch(`${base}${path}`, { method, headers: { cookie: staffCookie } });
      expect(res.status, `${method} ${path} leaked to staff`).toBe(401);
    }
  });

  it('EVERY mutating admin route requires the CSRF header (not just the ones we remembered)', async () => {
    const mutations: [string, string, unknown][] = [
      ['POST', '/admin-api/providers', { kind: 'local', label: 'x', baseUrl: 'http://vibellm:1/v1', authType: 'none' }],
      ['PATCH', `/admin-api/providers/${providerId}`, { label: 'renamed' }],
      ['DELETE', `/admin-api/providers/${providerId}`, undefined],
      ['POST', `/admin-api/providers/${providerId}/test`, {}],
      ['POST', `/admin-api/providers/${providerId}/credentials`, { apiKey: 'sk-attacker-key' }],
      ['POST', '/admin-api/models', { canonicalId: 'x/y', providerKind: 'local', displayName: 'x', contextWindow: 1 }],
      ['PATCH', '/admin-api/task-classes/tb_classification', { sensitivity: 'cloud_allowed' }],
      ['PUT', '/admin-api/policies/tb_classification', { defaultModel: 'ollama/qwen3:14b' }],
      ['POST', '/admin-api/policies/import', { version: 1, taskClasses: [], policies: [] }],
      ['PUT', '/admin-api/settings', { scrubber_mode: 'warn' }],
      ['POST', '/admin-api/app-tokens', { app: 'attacker' }],
      ['POST', '/admin-api/test-prompt', { taskClass: 'tb_classification', content: 'x' }],
    ];
    for (const [method, path, body] of mutations) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { cookie: adminCookie, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(res.status, `${method} ${path} accepted without CSRF header`).toBe(403);
    }
  });

  it('session cookies resist tampering: bad signature, swapped id, stripped signature', async () => {
    const [name, value] = adminCookie.split('=');
    const decoded = decodeURIComponent(value ?? '');
    const dot = decoded.lastIndexOf('.');
    const id = decoded.slice(0, dot);
    const sig = decoded.slice(dot + 1);

    const forged = [
      `${name}=${encodeURIComponent(`${id}.${sig.slice(0, -2)}xx`)}`, // wrong signature
      `${name}=${encodeURIComponent(`${randomBytes(24).toString('base64url')}.${sig}`)}`, // swapped id
      `${name}=${encodeURIComponent(id)}`, // no signature
      `${name}=${encodeURIComponent(`${id}.`)}`, // empty signature
    ];
    for (const cookie of forged) {
      const res = await fetch(`${base}/admin-api/providers`, { headers: { cookie } });
      expect(res.status, `forged cookie accepted: ${cookie.slice(0, 40)}`).toBe(401);
    }
  });

  // ── T2: credential confidentiality ────────────────────────────────────────
  it('no admin endpoint discloses key material — full response sweep', async () => {
    const readable = [
      '/admin-api/providers',
      '/admin-api/models',
      '/admin-api/task-classes',
      '/admin-api/policies',
      '/admin-api/settings',
      '/admin-api/dashboard/health',
      '/admin-api/dashboard/spend',
      '/admin-api/audit?limit=200',
      '/admin-api/audit.csv',
      '/admin-api/ledger.csv',
      '/admin-api/app-tokens',
    ];
    for (const path of readable) {
      const res = await fetch(`${base}${path}`, { headers: { cookie: adminCookie } });
      const text = await res.text();
      expect(text, `${path} leaked the API key`).not.toContain(SECRET_KEY);
      expect(text, `${path} leaked ciphertext`).not.toContain('ciphertext');
      expect(text, `${path} leaked a password hash`).not.toContain('scrypt$');
    }
    // a live connection test failure must not echo the key either
    const test = await fetch(`${base}/admin-api/providers/${providerId}/test`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-vibe-admin': '1' },
      body: JSON.stringify({ model: 'anthropic/claude-haiku-4-5' }),
    });
    expect(await test.text()).not.toContain(SECRET_KEY);
  });

  it('app tokens are never returned after issuance (mint-once)', async () => {
    const minted = await fetch(`${base}/admin-api/app-tokens`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-vibe-admin': '1' },
      body: JSON.stringify({ app: 'qa-d-app' }),
    });
    const { token } = (await minted.json()) as { token: string };
    expect(token).toMatch(/^vibe-qa-d-app-/);
    const listing = await (await fetch(`${base}/admin-api/app-tokens`, { headers: { cookie: adminCookie } })).text();
    expect(listing).not.toContain(token);
    expect(listing).not.toContain('tokenHash');
  });

  // ── T1: gateway token boundaries ──────────────────────────────────────────
  it('revoked app tokens stop working immediately', async () => {
    const [row] = await handle.db
      .insert(appTokens)
      .values({
        firmId,
        app: 'qa-revoke',
        tokenHash: (await import('../src/gateway/pipeline.js')).hashToken('qa-revoke-token-value'),
        scopes: ['chat'],
      })
      .returning();
    const call = (): Promise<Response> =>
      fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer qa-revoke-token-value',
          'x-vibe-task-class': 'tb_classification',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      });
    expect((await call()).status).toBe(200);
    await handle.db.update(appTokens).set({ revokedAt: new Date() }).where(eq(appTokens.id, row!.id));
    expect((await call()).status).toBe(401);
  });

  it('tokens without the chat scope cannot call the gateway', async () => {
    await handle.db.insert(appTokens).values({
      firmId,
      app: 'qa-noscope',
      tokenHash: (await import('../src/gateway/pipeline.js')).hashToken('qa-noscope-token'),
      scopes: [],
    });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer qa-noscope-token',
        'x-vibe-task-class': 'tb_classification',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(res.status).toBe(401);
  });

  // ── T5 / injection-shaped inputs ──────────────────────────────────────────
  it('prototype-pollution payloads cannot poison firm settings', async () => {
    const attack = await fetch(`${base}/admin-api/settings`, {
      method: 'PUT',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-vibe-admin': '1' },
      body: '{"__proto__":{"polluted":"yes"},"scrubber_mode":"redact"}',
    });
    expect([200, 400]).toContain(attack.status);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    const firm = await handle.db.query.firms.findFirst({ where: eq(firms.id, firmId) });
    expect(JSON.stringify(firm?.settings)).not.toContain('polluted');
  });

  it('SQL-shaped and traversal-shaped strings in query params are inert', async () => {
    const payloads = [
      "'; DROP TABLE usage_ledger; --",
      "' OR '1'='1",
      '../../../../etc/passwd',
      '%2e%2e%2fetc%2fpasswd',
      'truncated',
    ];
    for (const p of payloads) {
      const res = await fetch(`${base}/admin-api/models?search=${encodeURIComponent(p)}`, {
        headers: { cookie: adminCookie },
      });
      expect([200, 400]).toContain(res.status);
      const audit = await fetch(`${base}/admin-api/audit?event=${encodeURIComponent(p)}`, {
        headers: { cookie: adminCookie },
      });
      expect([200, 400], `audit ?event=${p} → ${audit.status}: ${await audit.text()}`).toContain(
        audit.status,
      );
    }
    // the table is still there
    const stillThere = await handle.db.query.usageLedger.findMany({ limit: 1 });
    expect(Array.isArray(stillThere)).toBe(true);
  });

  it('SSRF: admin API refuses to point a cloud provider at internal hosts', async () => {
    for (const baseUrl of [
      'http://127.0.0.1:5432/v1',
      'https://192.168.1.10/v1',
      'https://169.254.169.254/latest/meta-data',
      'https://postgres/v1',
    ]) {
      const res = await fetch(`${base}/admin-api/providers`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-vibe-admin': '1' },
        body: JSON.stringify({ kind: 'openai_compat', label: 'ssrf', baseUrl, authType: 'none' }),
      });
      expect(res.status, `SSRF target accepted: ${baseUrl}`).toBe(400);
    }
    // and a "local" provider may not be aimed at the public internet (covert cloud route)
    const covert = await fetch(`${base}/admin-api/providers`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-vibe-admin': '1' },
      body: JSON.stringify({ kind: 'local', label: 'covert', baseUrl: 'https://api.openai.com/v1', authType: 'none' }),
    });
    expect(covert.status).toBe(400);
  });

  it('gateway errors do not disclose provider labels or internal detail to apps', async () => {
    // point tb_doc_extract at the credential-less cloud provider path by asking for a class
    // whose provider has no key: the error must stay generic
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': 'zz_unknown_for_probe',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    const body = await res.text();
    expect(res.status).toBe(403);
    expect(body).not.toContain('QA-D Anthropic'); // no provider label
    expect(body).not.toContain('postgres'); // no infrastructure hostnames
    expect(body).not.toMatch(/at .*\.ts:\d+/); // no stack frames
  });

  it('login does not reveal whether an email exists (constant-ish work either way)', async () => {
    const sample = async (email: string): Promise<number> => {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        await login(email, 'definitely-the-wrong-password');
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      return times[2]!; // median
    };
    const known = await sample(DEMO.adminEmail);
    const unknown = await sample('nobody-here-at-all@demo.firm');
    // both paths must do password work; allow generous slack for CI noise
    const ratio = Math.max(known, unknown) / Math.max(1, Math.min(known, unknown));
    expect(ratio, `timing oracle: known=${known.toFixed(1)}ms unknown=${unknown.toFixed(1)}ms`).toBeLessThan(3);
  });

  it('session store does not grow without bound under repeated logins (memory DoS)', async () => {
    const { SessionStore: Store } = await import('../src/admin-api/session.js');
    const store = new Store('cap-test');
    for (let i = 0; i < 5000; i++) {
      store.create({ userId: `u${i}`, firmId, email: 'x@y.z', role: 'admin' });
    }
    expect(store.size).toBeLessThanOrEqual(1000);
  });

  // ── T4: cross-firm isolation on GLOBAL tables (Q-079) ──────────────────────
  it('a second firm blocks suite-wide sensitivity/catalog mutations (no cross-firm tampering)', async () => {
    // single-firm control: the sensitivity PATCH works when this is the only firm
    const ok = await fetch(`${base}/admin-api/task-classes/tb_classification`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'x-vibe-admin': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'single-firm ok' }),
    });
    expect(ok.status).toBe(200);

    // provision a SECOND firm + its admin — now global mutations become cross-firm tampering
    const [rival] = await handle.db
      .insert(firms)
      .values({ name: 'Rival CPA', slug: 'rival-firm-qad', settings: {} })
      .returning();
    await handle.db.insert(users).values({
      firmId: rival!.id,
      role: 'admin',
      email: 'admin@rival-qad.firm',
      displayName: 'Rival Admin',
      passwordHash: await hashPassword('rival-pw-123'),
    });
    const rivalCookie =
      ((await login('admin@rival-qad.firm', 'rival-pw-123')).headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const before = await handle.db.query.taskClasses.findFirst({
      where: (t, { eq: eq_ }) => eq_(t.key, 'tb_classification'),
    });
    // rival admin (valid session) tries to WIDEN a class the other firm relies on → refused
    const attack = await fetch(`${base}/admin-api/task-classes/tb_classification`, {
      method: 'PATCH',
      headers: { cookie: rivalCookie, 'x-vibe-admin': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ sensitivity: 'cloud_allowed' }),
    });
    expect(attack.status).toBe(403);
    const after = await handle.db.query.taskClasses.findFirst({
      where: (t, { eq: eq_ }) => eq_(t.key, 'tb_classification'),
    });
    expect(after?.sensitivity).toBe(before?.sensitivity); // boundary unchanged

    // model-catalog global mutations are likewise refused in multi-firm
    const model = await handle.db.query.models.findFirst();
    const retire = await fetch(`${base}/admin-api/models/${model!.id}/retire`, {
      method: 'POST',
      headers: { cookie: rivalCookie, 'x-vibe-admin': '1' },
    });
    expect(retire.status).toBe(403);

    // cleanup so later ordering-independent runs see one firm again
    await handle.db.delete(users).where(eq(users.email, 'admin@rival-qad.firm'));
    await handle.db.delete(firms).where(eq(firms.id, rival!.id));
  });
});
