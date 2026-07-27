import { defineConfig } from '@playwright/test';

/**
 * E2E smoke (11.10): boots the REAL router (serving ui/dist) against the test database, with a
 * mock OpenAI-shaped model server standing in for vibellm (started in global-setup).
 */
const DB = process.env['VIBE_ROUTER_TEST_DATABASE_URL'] ?? 'postgres://airouter:airouter@localhost:55433/airouter';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:8228',
  },
  webServer: {
    command: 'pnpm --dir .. exec tsx src/server/index.ts',
    url: 'http://127.0.0.1:8228/healthz',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      DATABASE_URL: DB,
      PORT: '8228',
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      CATALOG_SYNC_CRON: '',
      SESSION_SECRET: 'e2e-smoke-session-secret',
    },
  },
});
