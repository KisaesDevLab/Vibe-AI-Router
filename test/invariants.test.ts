/**
 * INVARIANT SUITE (8.8) — runs in CI on every commit from Phase 8 onward.
 *   (a) no prompt body in any DB table or log output
 *   (b) local_only task class cannot reach a cloud adapter (even with a tampered policy row)
 *   (c) scrubber match on a cloud-bound request returns 4xx
 *   (d) every completed request produces exactly one ledger write (interface-level here;
 *       Phase 9 adds the DB-level row assertion)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { PolicyEngine } from '../src/policy/engine.js';
import type { LedgerWriter, PipelineCtx } from '../src/gateway/pipeline.js';
import { StubAdapter } from '../src/gateway/stub-adapter.js';
import { createLogger } from '../src/lib/logger.js';
import { writeAudit, type AuditEntry } from '../src/protect/audit.js';
import { firms, models, policies, providers, taskClasses } from '../db/schema.js';
import { resetDb } from './helpers.js';
import { DEMO } from '../db/seed.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];

const MARKER = 'ZQXINVARIANTMARKER77';

class CountingLedger implements LedgerWriter {
  writes: string[] = [];
  write(ctx: PipelineCtx): Promise<void> {
    this.writes.push(ctx.requestId);
    return Promise.resolve();
  }
}

describe.skipIf(!url)('invariant suite', () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  let base: string;
  let logLines: string[];
  let ledger: CountingLedger;

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 3);
    logLines = [];
    const logStream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        logLines.push(chunk.toString());
        cb();
      },
    });
    ledger = new CountingLedger();
    // cloud-capable keyless provider so cloud-bound requests can route without a vault
    const firm = await handle.db.query.firms.findFirst();
    await handle.db.insert(providers).values({
      firmId: firm!.id,
      kind: 'openai_compat',
      label: 'Cloud (mock)',
      baseUrl: 'http://127.0.0.1:1/v1', // never actually reached — stub adapter serves
      authType: 'none',
    });

    app = buildApp({
      env: loadEnv({ DATABASE_URL: dbUrl, NODE_ENV: 'test' }),
      gateway: {
        deps: {
          db: handle.db,
          adapters: { forKind: () => new StubAdapter('invariant stub reply') },
          ledger,
          log: createLogger('debug', false, logStream),
          engine: new PolicyEngine(handle.db, 10),
          ssrfDenyPrivateCloud: false, // tests use loopback cloud mocks (14.2 toggle)
          audit: (entry: AuditEntry) => void writeAudit(handle.db, entry).catch(() => {}),
        },
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

  const chat = (
    taskClass: string,
    content: string,
    extra?: Record<string, unknown>,
  ): Promise<Response> =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': taskClass,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content }], ...extra }),
    });

  it('(a) prompt bodies never persist to ANY table and never appear in logs', async () => {
    const res = await chat('tb_classification', `classify this: ${MARKER} office supplies 88.12`);
    expect(res.status).toBe(200);
    // give fire-and-forget audit a beat
    await new Promise((r) => setTimeout(r, 150));

    // every user table, every row, serialized — the marker must be nowhere
    const tables = await handle.sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    for (const { tablename } of tables) {
      const rows = await handle.sql.unsafe(
        `SELECT to_jsonb(t)::text AS j FROM "${tablename}" t`,
      );
      for (const row of rows as unknown as { j: string }[]) {
        expect(row.j, `marker leaked into table ${tablename}`).not.toContain(MARKER);
      }
    }
    expect(logLines.join(''), 'marker leaked into logs').not.toContain(MARKER);
  });

  it('(b) local_only cannot reach a cloud adapter — even with a TAMPERED policy row', async () => {
    // bypass savePolicy's config-time gate: write a cloud default straight into the DB
    const tc = await handle.db.query.taskClasses.findFirst({
      where: eq(taskClasses.key, 'tb_classification'),
    });
    const cloudModel = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'openai/gpt-4o-mini'),
    });
    const firm = await handle.db.query.firms.findFirst();
    await handle.db
      .update(policies)
      .set({ defaultModelId: cloudModel!.id, allowedModelIds: [cloudModel!.id] })
      .where(eq(policies.taskClassId, tc!.id));
    await new Promise((r) => setTimeout(r, 30)); // outlive the 10ms engine TTL

    const res = await chat('tb_classification', 'route me to the cloud please');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('policy_blocked');
    expect(body.error.message).toMatch(/local_only/);

    // restore for subsequent tests
    const localModel = await handle.db.query.models.findFirst({
      where: eq(models.canonicalId, 'ollama/qwen3:14b'),
    });
    await handle.db
      .update(policies)
      .set({ defaultModelId: localModel!.id, allowedModelIds: [localModel!.id] })
      .where(eq(policies.taskClassId, tc!.id));
    void firm;
  });

  it('(c) scrubber match on cloud-bound request → 422, match types only', async () => {
    await new Promise((r) => setTimeout(r, 30)); // engine TTL
    const res = await chat('tb_doc_extract', 'extract W-2 for SSN 123-45-6789', {
      response_format: { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' } } },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; detail?: { matches: Record<string, number> } } };
    expect(body.error.code).toBe('scrubber_blocked');
    expect(body.error.detail?.matches).toEqual({ ssn: 1 });
    expect(JSON.stringify(body)).not.toContain('123-45-6789');

    // audit carries counts only
    await new Promise((r) => setTimeout(r, 150));
    const audits = await handle.db.query.auditLog.findMany();
    const blocked = audits.filter((a) => a.event === 'blocked_scrubber');
    expect(blocked.length).toBeGreaterThan(0);
    expect(JSON.stringify(blocked)).not.toContain('123-45-6789');
  });

  it('(c2) same request on the LOCAL tier passes untouched (local tier exempt, 8.2)', async () => {
    const res = await chat('tb_classification', 'classify SSN 123-45-6789 payroll withholding row');
    expect(res.status).toBe(200);
  });

  it('(c3) redact mode: adapter receives the scrubbed copy, response flows', async () => {
    const firm = await handle.db.query.firms.findFirst();
    await handle.db
      .update(firms)
      .set({ settings: { scrubber_mode: 'redact' } })
      .where(eq(firms.id, firm!.id));
    await new Promise((r) => setTimeout(r, 30));

    let adapterSaw = '';
    const spyAdapter = new (class extends StubAdapter {
      override execute(env: Parameters<StubAdapter['execute']>[0], ctx: Parameters<StubAdapter['execute']>[1], s: AbortSignal) {
        adapterSaw = JSON.stringify(env.messages);
        return super.execute(env, ctx, s);
      }
    })('redacted ok');

    // swap adapter by re-registering? — simpler: dedicated app instance
    const app2 = buildApp({
      env: loadEnv({ DATABASE_URL: url as string, NODE_ENV: 'test' }),
      gateway: {
        deps: {
          db: handle.db,
          adapters: { forKind: () => spyAdapter },
          ledger,
          log: createLogger('silent', false),
          engine: new PolicyEngine(handle.db, 10),
          ssrfDenyPrivateCloud: false, // tests use loopback cloud mocks (14.2 toggle)
        },
      },
    });
    await app2.listen({ port: 0, host: '127.0.0.1' });
    const addr2 = app2.server.address();
    const base2 = typeof addr2 === 'object' && addr2 ? `http://127.0.0.1:${addr2.port}` : '';
    const res = await fetch(`${base2}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO.appToken}`,
        'x-vibe-task-class': 'tb_doc_extract',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'extract from card 4111111111111111 statement' }],
        response_format: { type: 'json_schema', json_schema: { name: 'out', schema: {} } },
      }),
    });
    expect(res.status).toBe(200);
    expect(adapterSaw).toContain('[CARD]');
    expect(adapterSaw).not.toContain('4111111111111111');
    await app2.close();

    // restore block mode
    await handle.db
      .update(firms)
      .set({ settings: { scrubber_mode: 'block' } })
      .where(eq(firms.id, firm!.id));
  });

  it('(d) exactly one ledger write per request — success and failure alike', async () => {
    const before = ledger.writes.length;
    const ok = await chat('tb_classification', 'ledger check ok');
    expect(ok.status).toBe(200);
    const blocked = await chat('no_such_class_xyz', 'ledger check blocked');
    expect(blocked.status).toBe(403);
    expect(ledger.writes.length).toBe(before + 2);
    // all writes have unique request ids (idempotency key discipline)
    expect(new Set(ledger.writes).size).toBe(ledger.writes.length);
  });
});
