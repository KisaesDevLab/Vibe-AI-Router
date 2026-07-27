import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const BASE = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('env config', () => {
  it('applies defaults', () => {
    const env = loadEnv({ ...BASE });
    expect(env.PORT).toBe(8220);
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.REDIS_URL).toBeUndefined();
  });

  it('refuses to boot without DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(/refusing to boot/);
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('refuses to boot on malformed values', () => {
    expect(() => loadEnv({ ...BASE, PORT: 'not-a-port' })).toThrow(/refusing to boot/);
    expect(() => loadEnv({ ...BASE, PORT: '70000' })).toThrow(/refusing to boot/);
    expect(() => loadEnv({ ...BASE, LOG_LEVEL: 'loud' })).toThrow(/refusing to boot/);
    expect(() => loadEnv({ ...BASE, REDIS_URL: 'not a url' })).toThrow(/refusing to boot/);
  });

  it('accepts a full valid config', () => {
    const env = loadEnv({
      ...BASE,
      NODE_ENV: 'production',
      PORT: '8221',
      HOST: '0.0.0.0',
      REDIS_URL: 'redis://localhost:6379/0',
      LOG_LEVEL: 'warn',
    });
    expect(env.PORT).toBe(8221);
    expect(env.REDIS_URL).toBe('redis://localhost:6379/0');
  });
});
