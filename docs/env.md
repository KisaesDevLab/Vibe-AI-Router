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
| `ROUTER_MAX_BODY_BYTES` | no | `10485760` | gateway request body cap (2.9) |
| `ROUTER_MAX_MESSAGES` | no | `200` | max messages per request |
| `ROUTER_MAX_JSON_DEPTH` | no | `24` | JSON nesting cap, checked before schema parse |
| `CATALOG_SYNC_CRON` | no | `15 3 * * *` | nightly catalog sync schedule; empty string disables |
| `ADMIN_BOOTSTRAP_TOKEN` | no | — | ≥16 chars; enables pre-UI admin endpoints (`/admin/catalog/sync`); unset → routes not registered |

Test-only:

| Variable | Purpose |
| --- | --- |
| `VIBE_ROUTER_TEST_DATABASE_URL` | When set, DB-backed test suites run against it (they self-skip otherwise) |
