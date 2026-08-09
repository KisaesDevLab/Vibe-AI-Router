/**
 * WISP AI Data-Handling Appendix export (14.7). Two layers under test: buildWispData reads
 * LIVE firm-scoped config (reflects admin tier/provider edits, firm-isolated), and
 * renderWispDocx emits a valid .docx. Plus the admin endpoint (auth + attachment + firm scope).
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
import { buildWispData, renderWispDocx } from '../src/ops/wisp.js';
import { firms, providers, users } from '../db/schema.js';
import { resetDb } from './helpers.js';
import { DEMO } from '../db/seed.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

describe.skipIf(!url)('WISP appendix export', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let base: string;
  let firmId: string;

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 3);
    firmId = (await handle.db.query.firms.findFirst())!.id;
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
        sessions: new SessionStore('wisp-test-secret'),
        secureCookies: false,
        adapterFor: () => undefined,
        retentionDays: 90,
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

  const adminCookie = async (): Promise<string> => {
    const res = await fetch(`${base}/admin-api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vibe-admin': '1' },
      body: JSON.stringify({ email: DEMO.adminEmail, password: DEMO.adminPassword }),
    });
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };

  it('buildWispData reflects the live seeded config (tiers, providers, scrubber, retention)', async () => {
    const data = await buildWispData(handle.db, firmId, 90);
    expect(data.firmName).toBe('Demo Firm CPA');
    expect(data.scrubberMode).toBe('redact'); // seed sets settings.scrubber_mode
    expect(data.retentionDays).toBe(90);
    expect(data.zeroCloud).toBe(true); // seed configures only a local provider
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0]).toMatchObject({ tier: 'local' });
    expect(data.matchTypes).toEqual(['ssn', 'ein', 'routing', 'account', 'card']);

    const cls = new Map(data.taskClasses.map((t) => [t.key, t]));
    expect(cls.get('tb_classification')).toMatchObject({ tier: 'LOCAL', servedBy: 'ollama/qwen3:14b' });
    expect(cls.get('tb_classification')!.leavesAppliance).toMatch(/No —/);
    expect(cls.get('tb_research_summary')).toMatchObject({ tier: 'CLOUD' });
  });

  it('a cloud provider flips zeroCloud and appears classified as cloud', async () => {
    await handle.db.insert(providers).values({
      firmId,
      kind: 'anthropic',
      label: 'Firm Anthropic',
      baseUrl: 'https://api.anthropic.com',
      authType: 'api_key',
    });
    const data = await buildWispData(handle.db, firmId, undefined);
    expect(data.zeroCloud).toBe(false);
    expect(data.retentionDays).toBeUndefined();
    expect(data.providers.find((p) => p.label === 'Firm Anthropic')).toMatchObject({ tier: 'cloud' });
    // clean up so later assertions on provider count are stable
    await handle.db.delete(providers).where(eq(providers.label, 'Firm Anthropic'));
  });

  it('renderWispDocx produces a valid .docx (PK zip magic), non-empty', async () => {
    const data = await buildWispData(handle.db, firmId, 90);
    const buf = await renderWispDocx(data);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK'); // OOXML is a zip
  });

  it('GET /admin-api/wisp.docx: admin → 200 docx attachment; unauthenticated → 401', async () => {
    expect((await fetch(`${base}/admin-api/wisp.docx`)).status).toBe(401);

    const res = await fetch(`${base}/admin-api/wisp.docx`, { headers: { cookie: await adminCookie() } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('officedocument.wordprocessingml.document');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('AI-Data-Handling-Appendix.docx');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('is firm-scoped: a second firm sees only its own providers', async () => {
    const [rival] = await handle.db
      .insert(firms)
      .values({ name: 'Rival CPA', slug: 'rival-wisp', settings: { scrubber_mode: 'block' } })
      .returning();
    await handle.db.insert(users).values({
      firmId: rival!.id,
      role: 'admin',
      email: 'admin@rival-wisp.firm',
      displayName: 'Rival',
      passwordHash: await hashPassword('pw'),
    });
    await handle.db.insert(providers).values({
      firmId: rival!.id,
      kind: 'local',
      label: 'Rival Local',
      baseUrl: 'http://vibellm:11434/v1',
      authType: 'none',
    });

    const rivalData = await buildWispData(handle.db, rival!.id, undefined);
    expect(rivalData.firmName).toBe('Rival CPA');
    expect(rivalData.scrubberMode).toBe('block');
    expect(rivalData.providers.map((p) => p.label)).toEqual(['Rival Local']); // NOT the demo firm's provider

    await handle.db.delete(users).where(eq(users.email, 'admin@rival-wisp.firm'));
    await handle.db.delete(providers).where(eq(providers.label, 'Rival Local'));
    await handle.db.delete(firms).where(eq(firms.id, rival!.id));
  });
});
