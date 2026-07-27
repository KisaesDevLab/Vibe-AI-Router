import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // DB-backed tests read VIBE_ROUTER_TEST_DATABASE_URL; suites skip themselves when it is unset
    // so the pure-unit tier always runs anywhere.
    testTimeout: 15_000,
    pool: 'forks',
  },
});
