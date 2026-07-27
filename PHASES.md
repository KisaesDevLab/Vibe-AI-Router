# PHASES.md — per-item build status

Mirrors `VIBE-AI-ROUTER-BUILD-PLAN.md` (source of truth for full item text). `[x]` done,
`[~]` partial (note why), `[ ]` open. Acceptance line per phase when met.

## Phase 0 — Scaffolding & Decisions

- [x] 0.1 Repo init, TS strict, ESLint/Prettier, Vitest, tsx
- [x] 0.2 Fastify skeleton /healthz + /version
- [x] 0.3 Docker multi-stage + dev compose (pg16, redis7)
- [x] 0.4 Migration tooling wired; 0000_init runs clean
- [x] 0.5 CLAUDE.md
- [x] 0.6 PHASES.md + STATE.md
- [x] 0.7 CI (typecheck, lint, test, build, docker, up-down-up)
- [x] 0.8 DECISIONS.md (D-001..D-007: license, Fastify, port 8220, service name)
- [x] 0.9 Zod env config, refuse-to-boot, docs/env.md
- [x] 0.10 Pino with redaction paths pre-configured

## Phase 1 — Data Model

- [x] 1.1 firms
- [x] 1.2 users (+ email/display_name for Phase 11 auth — see STATE 2026-07-26)
- [x] 1.3 providers (soft delete, health jsonb, model_mapping for Azure)
- [x] 1.4 provider_credentials (no plaintext column; rotation fields ready for Phase 6)
- [x] 1.5 models (+ capability_overrides ready for Phase 5.5)
- [x] 1.6 model_pricing (append-only history)
- [x] 1.7 task_classes
- [x] 1.8 policies (unique firm+task_class)
- [x] 1.9 role_policies
- [x] 1.10 usage_ledger (request_id unique = idempotency; cost numeric(12,6))
- [x] 1.11 audit_log (append-only enforced by trigger; event as text per Q-005)
- [x] 1.12 budgets_state (unique scope/scope_ref/period)
- [x] 1.13 app_tokens
- [x] 1.14 indexes
- [x] 1.15 seed script (demo firm, admin, local provider, 3 classes × 3 tiers, 5 models, policies, app token)
- [x] 1.16 reversibility up→down→up in CI + lingering-table assertion

**Acceptance met:** `pnpm seed` navigable + idempotent (test-verified); schema doc at docs/schema.md.

## Phase 2 — Gateway Core & Envelope

- [ ] 2.1 … 2.10

## Phase 3 — Adapter Framework + OpenAI-Compatible Adapter

- [ ] 3.1 … 3.10

## Phase 4 — Anthropic Native Adapter

- [ ] 4.1 … 4.8

## Phase 5 — Model Catalog & Pricing Sync

- [ ] 5.1 … 5.9

## Phase 6 — Credential Vault

- [ ] 6.1 … 6.8

## Phase 7 — Task-Class Policy Engine

- [ ] 7.1 … 7.11

## Phase 8 — Data Protection (Scrubber + Audit)

- [ ] 8.1 … 8.9

## Phase 9 — Cost Ledger & Budgets

- [ ] 9.1 … 9.11

## Phase 10 — Resilience

- [ ] 10.1 … 10.9

## Phase 11 — Admin API + Admin UI

- [ ] 11.1 … 11.10

## Phase 12 — App Integration SDK & First App Migration

- [ ] 12.1 … 12.8

## Phase 13 — Ops, Metrics, Caching, Packaging

- [ ] 13.1 … 13.8

## Phase 14 — Security Review, Load Test, Hardening

- [ ] 14.1 … 14.9

## Phase 15 — Human Review

- [ ] 15.1 … 15.12
