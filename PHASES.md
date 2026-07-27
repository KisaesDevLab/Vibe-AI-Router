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

- [ ] 1.1 firms … [ ] 1.16 reversibility test (see plan)

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
