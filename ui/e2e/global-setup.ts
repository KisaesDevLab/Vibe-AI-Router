/**
 * E2E global setup: reset+seed the test DB, point the seeded local provider at an in-process
 * OpenAI-shaped mock model server (port 8229, suite block), and keep that mock alive for the
 * whole run.
 */
import { createServer } from 'node:http';
import { migrate } from '../../db/migrate.js';
import { seed } from '../../db/seed.js';
import { createDb } from '../../src/db/client.js';
import { providers } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

const DB = process.env['VIBE_ROUTER_TEST_DATABASE_URL'] ?? 'postgres://airouter:airouter@localhost:55433/airouter';

export default async function globalSetup(): Promise<() => Promise<void>> {
  process.env['VIBE_ROUTER_TEST_DATABASE_URL'] = DB;

  await migrate(DB, 'down', Infinity);
  await migrate(DB, 'up');
  await seed(DB);

  const { db, close } = createDb(DB, 2);
  await db
    .update(providers)
    .set({ baseUrl: 'http://127.0.0.1:8229/v1' })
    .where(eq(providers.kind, 'local'));
  await close();

  // mock model server: /v1/models, /v1/chat/completions, /api/show
  const mock = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3:14b' }] }));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/api/show')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['tools'], model_info: { 'qwen3.context_length': 32768 } }));
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            { message: { content: 'E2E mock reply: the router is reachable.' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        }),
      );
      void body;
    });
  });
  await new Promise<void>((r) => mock.listen(8229, '127.0.0.1', r));

  return async () => {
    await new Promise<void>((r) => mock.close(() => r()));
  };
}
