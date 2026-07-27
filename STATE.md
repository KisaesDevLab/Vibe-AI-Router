# STATE.md — build verification journal

Newest first. Updated after every meaningful change (suite build-kit convention).

## 2026-07-26 — Phase 1 complete

- 16-table schema live: db/schema.ts (drizzle, type source) + 0001_data_model up/down SQL.
  Enums for roles/kinds/statuses/sensitivity; audit event kept text (Q-005). updated_at via
  trigger; audit_log append-only enforced by trigger and test.
- Seed: demo firm + admin + local vibellm provider + 5 priced fixture models + 3 task classes
  (one per sensitivity tier) + capability-valid policies + hashed demo app token. Idempotent
  (re-run test-verified).
- Verified: typecheck/lint clean; 11/11 tests green incl. up→down→up over full schema with
  zero lingering tables, seed idempotency, append-only trigger rejection.
- Note: vitest fileParallelism disabled — DB suites share one database.

## 2026-07-26 — Phase 0 in progress

- Repo scaffolded: pnpm workspace (root server + future packages/*, ui), TS strict
  (exactOptionalPropertyTypes, noUncheckedIndexedAccess), eslint flat config (correctness only),
  prettier, vitest, tsx.
- Fastify skeleton: /healthz, /version. buildApp() separated from listen() for inject() tests.
- Env config: zod-validated, refuses boot on invalid input (src/config/env.ts). Documented in
  docs/env.md.
- Logger: pino with redaction paths for messages/choices/content/credentials — present before
  any AI traffic exists (0.10).
- Migrations: custom reversible runner (db/migrate.ts), 0000_init baseline pair.
- Docker: multi-stage node:20-alpine, non-root, healthcheck; compose dev stack pg16 + redis7
  (host ports 55433/56380), router on 8220.
- CI: typecheck / lint / up-down-up migration check / test / build / docker build with pg+redis
  services.
- DECISIONS.md D-001..D-007; QUESTIONS.md Q-001..Q-004.
- Verified locally: typecheck clean, lint clean, 9/9 tests green (incl. DB-backed up→down→up
  reversibility against compose Postgres on 55433), `pnpm build` + production boot on :8225
  answered /healthz and /version. Docker image build deferred to CI.
