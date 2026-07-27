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
| `ADMIN_BOOTSTRAP_TOKEN` | no | — | ≥16 chars; enables pre-UI admin endpoints (`/admin/*`); unset → routes not registered |
| `MASTER_KEY` | no | — | 32B base64 vault master key; unset → cloud credentials unavailable, local-only mode still serves |
| `MASTER_KEY_VERSION` | no | `1` | keyring version of `MASTER_KEY` |
| `MASTER_KEY_PREVIOUS` | no | — | previous master key during a rotation window |
| `MASTER_KEY_PREVIOUS_VERSION` | no | `MASTER_KEY_VERSION - 1` | version of the previous key |
| `CREDENTIAL_GRACE_HOURS` | no | `24` | demoted credentials auto-revoke after this long in grace |
| `RATE_LIMIT_PER_TOKEN_RPM` | no | `600` | sustained requests/min per app token (0 disables) |
| `RATE_LIMIT_PER_USER_RPM` | no | `240` | sustained requests/min per user (0 disables) |
| `UPSTREAM_MAX_CONCURRENCY` | no | `16` | max concurrent upstream calls per provider |
| `UPSTREAM_QUEUE_CAP` | no | `32` | waiting-queue cap per provider before shedding (429) |
| `BREAKER_OPEN_MS` | no | `30000` | circuit-breaker open duration before half-open probe |
| `ROUTER_TIMEOUT_TOTAL_MS` | no | `120000` | total upstream budget per request |
| `ROUTER_TIMEOUT_STREAM_IDLE_MS` | no | `60000` | streaming idle watchdog |
| `SESSION_SECRET` | no | random per boot | admin-UI session signing (≥16 chars); unset → sessions reset on restart |
| `SECURE_COOKIES` | no | `false` | set `true` behind HTTPS (Caddy) — marks session cookies Secure |
| `LEDGER_RETENTION_DAYS` | no | — (retain forever) | daily purge of usage_ledger rows older than N days; audit_log is never purged |
| `SSRF_DENY_PRIVATE_CLOUD` | no | `true` | request-time rejection of cloud providers on private hosts (14.2); leave on |

Test-only:

| Variable | Purpose |
| --- | --- |
| `VIBE_ROUTER_TEST_DATABASE_URL` | When set, DB-backed test suites run against it (they self-skip otherwise) |
