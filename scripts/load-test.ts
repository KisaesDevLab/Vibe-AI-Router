/**
 * Load test (14.4): sustained mixed streaming/non-streaming load against an instant mock
 * provider through the FULL pipeline (auth→policy→budget→scrub→route→adapt→ledger). Because
 * the upstream answers in ~0ms, client-observed latency ≈ router-added overhead.
 *
 *   LOAD_RPS=50 LOAD_SECONDS=60 DATABASE_URL=… pnpm tsx scripts/load-test.ts
 */
import { createServer } from 'node:http';
import { migrate } from '../db/migrate.js';
import { seed, DEMO } from '../db/seed.js';
import { createDb } from '../src/db/client.js';
import { providers } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { DbLedger } from '../src/ledger/writer.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { createLogger } from '../src/lib/logger.js';
import { CircuitBreaker } from '../src/resilience/breaker.js';
import { LoadShedGuard } from '../src/resilience/shed.js';
import { Metrics } from '../src/ops/metrics.js';

const out = (m: string): void => void process.stdout.write(m + '\n');
const RPS = Number(process.env['LOAD_RPS'] ?? 50);
const SECONDS = Number(process.env['LOAD_SECONDS'] ?? 60);
const DB = process.env['DATABASE_URL'] ?? 'postgres://airouter:airouter@localhost:55433/airouter';

async function main(): Promise<void> {
  await migrate(DB, 'up');
  await seed(DB);
  const handle = createDb(DB, 20);

  // instant mock provider
  const mock = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const stream = (JSON.parse(body || '{}') as { stream?: boolean }).stream;
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          'data: {"choices":[{"delta":{"content":"load test reply"},"finish_reason":null}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
        );
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          '{"choices":[{"message":{"content":"load test reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3}}',
        );
      }
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const mockAddr = mock.address();
  const mockPort = typeof mockAddr === 'object' && mockAddr ? mockAddr.port : 0;
  await handle.db
    .update(providers)
    .set({ baseUrl: `http://127.0.0.1:${mockPort}/v1` })
    .where(eq(providers.kind, 'local'));

  const app = buildApp({
    env: loadEnv({ DATABASE_URL: DB, NODE_ENV: 'production', LOG_LEVEL: 'error' }),
    gateway: {
      deps: {
        db: handle.db,
        adapters: createAdapterRegistry(),
        ledger: new DbLedger(handle.db),
        log: createLogger('error', false),
        engine: new PolicyEngine(handle.db),
        metrics: new Metrics(() => []),
        resilience: {
          breaker: new CircuitBreaker(),
          shed: new LoadShedGuard(64, 128),
          totalTimeoutMs: 30_000,
          streamIdleTimeoutMs: 10_000,
        },
      },
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const memStart = process.memoryUsage().rss;

  // soak mode (LOAD_SAMPLE_EVERY_S): periodic memory samples so drift is visible, not inferred
  const sampleEvery = Number(process.env['LOAD_SAMPLE_EVERY_S'] ?? 0);
  const samples: { t: number; rssMb: number; heapMb: number; cache: number }[] = [];
  const sampler = sampleEvery
    ? setInterval(() => {
        const m = process.memoryUsage();
        const s = {
          t: samples.length * sampleEvery,
          rssMb: Math.round(m.rss / 1e6),
          heapMb: Math.round(m.heapUsed / 1e6),
          cache: 0,
        };
        samples.push(s);
        out(`  t+${s.t}s rss=${s.rssMb}MB heap=${s.heapMb}MB`);
      }, sampleEvery * 1000)
    : undefined;
  sampler?.unref();

  /**
   * Uniformly paced run (no bursts — burst firing measures queueing, not the router).
   * target 'direct' hits the mock itself; 'router' goes through the full pipeline. The
   * 25ms budget applies to the DELTA (added latency, excluding upstream + harness).
   */
  const run = async (
    target: 'direct' | 'router',
    seconds: number,
  ): Promise<{ latencies: number[]; errors: number; sent: number }> => {
    const latencies: number[] = [];
    let errors = 0;
    const total = RPS * seconds;
    const interval = 1000 / RPS;
    const t0 = performance.now();
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < total; i++) {
      const startAt = i * interval;
      jobs.push(
        (async (): Promise<void> => {
          const wait = startAt - (performance.now() - t0);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          const stream = i % 3 === 0; // ~33% streaming
          const begin = performance.now();
          try {
            const res = await fetch(
              target === 'router'
                ? `${base}/v1/chat/completions`
                : `http://127.0.0.1:${mockPort}/v1/chat/completions`,
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: `Bearer ${DEMO.appToken}`,
                  'x-vibe-task-class': 'tb_classification',
                },
                body: JSON.stringify({
                  messages: [{ role: 'user', content: `classify account row ${i} office supplies` }],
                  stream,
                }),
              },
            );
            await res.text();
            if (res.status !== 200) errors++;
          } catch {
            errors++;
          }
          latencies.push(performance.now() - begin);
        })(),
      );
    }
    await Promise.all(jobs);
    latencies.sort((a, b) => a - b);
    return { latencies, errors, sent: total };
  };

  const pct = (arr: number[], p: number): number =>
    arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] ?? 0;

  out(`baseline: ${RPS} rps direct-to-mock for 15s …`);
  const direct = await run('direct', 15);
  out(`  direct p50=${pct(direct.latencies, 0.5).toFixed(1)}ms p95=${pct(direct.latencies, 0.95).toFixed(1)}ms`);

  out(`router: ${RPS} rps through the full pipeline for ${SECONDS}s (mixed ~33% streaming) …`);
  const router = await run('router', SECONDS);
  const memEnd = process.memoryUsage().rss;

  const overheadP50 = pct(router.latencies, 0.5) - pct(direct.latencies, 0.5);
  const overheadP95 = pct(router.latencies, 0.95) - pct(direct.latencies, 0.95);
  out(`sent=${router.sent} errors=${router.errors}`);
  out(
    `router ms: p50=${pct(router.latencies, 0.5).toFixed(1)} p95=${pct(router.latencies, 0.95).toFixed(1)} p99=${pct(router.latencies, 0.99).toFixed(1)}`,
  );
  out(`added latency (router − direct): p50=${overheadP50.toFixed(1)}ms p95=${overheadP95.toFixed(1)}ms`);
  out(`rss: start=${(memStart / 1e6).toFixed(0)}MB end=${(memEnd / 1e6).toFixed(0)}MB delta=${((memEnd - memStart) / 1e6).toFixed(0)}MB`);
  let pass = overheadP95 < 25 && router.errors <= router.sent * 0.01;
  out(`p95 added-latency budget (<25ms excl. upstream): ${pass ? 'PASS' : 'FAIL'}`);

  if (sampler) {
    clearInterval(sampler);
    // memory stability: compare the last third of samples against the first third once the
    // process is warm — a leak shows as monotonic growth, not as warm-up allocation.
    const third = Math.max(1, Math.floor(samples.length / 3));
    const early = samples.slice(third, third * 2);
    const late = samples.slice(-third);
    const avg = (xs: typeof samples): number => xs.reduce((s, x) => s + x.rssMb, 0) / Math.max(1, xs.length);
    const drift = avg(late) - avg(early);
    const peak = Math.max(...samples.map((s) => s.rssMb));
    out(
      `soak memory: mid-run avg=${avg(early).toFixed(0)}MB late avg=${avg(late).toFixed(0)}MB drift=${drift.toFixed(0)}MB peak=${peak}MB over ${samples.length} samples`,
    );
    const stable = drift < 50;
    out(`memory-stability budget (<50MB drift after warm-up): ${stable ? 'PASS' : 'FAIL'}`);
    pass = pass && stable;
  }

  await app.close();
  mock.close();
  await handle.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e) + '\n');
  process.exit(1);
});
