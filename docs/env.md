# Environment variables

Every variable the router reads. An undocumented variable is a gap-checklist failure.
Validation: `src/config/env.ts` (zod). Invalid config → the process refuses to boot.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | `development` \| `test` \| `production` |
| `PORT` | no | `8220` | HTTP listen port (suite block 8220–8229) |
| `HOST` | no | `127.0.0.1` | Listen address; set `0.0.0.0` in containers |
| `DATABASE_URL` | **yes** | — | Postgres 16 connection string |
| `REDIS_URL` | no | — | Optional Redis; absent → in-memory fallbacks (rate limits, breaker state, cache) |
| `LOG_LEVEL` | no | `info` | pino level |

Test-only:

| Variable | Purpose |
| --- | --- |
| `VIBE_ROUTER_TEST_DATABASE_URL` | When set, DB-backed test suites run against it (they self-skip otherwise) |
