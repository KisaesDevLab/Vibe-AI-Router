import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { loadEnv } from '../src/config/env.js';
import { VERSION } from '../src/version.js';

const app = buildApp({
  env: loadEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', NODE_ENV: 'test' }),
});

afterAll(() => app.close());

describe('server skeleton', () => {
  it('GET /healthz → ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /version → name + version', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'vibe-ai-router', version: VERSION });
  });
});
