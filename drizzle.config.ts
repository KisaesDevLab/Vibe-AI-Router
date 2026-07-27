import { defineConfig } from 'drizzle-kit';

// drizzle-kit is used for schema diffing assistance only; applied migrations are the
// hand-authored up/down SQL pairs under db/migrations (see db/migrate.ts and Q-001).
export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './db/.drizzle-kit',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://airouter:airouter@localhost:55433/airouter',
  },
});
