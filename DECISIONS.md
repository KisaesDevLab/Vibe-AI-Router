# DECISIONS.md — architecture decision record

Reviewed by Kurt in Phase 15. Format: decision → rationale → reversal cost.

## D-001 — License: BSL 1.1 (Apache 2.0 at 4-year change date)

Matches Vibe Trial Balance. Firm-hosted commercial product; BSL blocks competitive hosted
resale while converting to genuinely open source on a clock. **Reversal: S** (swap LICENSE +
headers before 1.0).

## D-002 — Fastify over Express

First-class SSE streaming (reply.raw + async iterators without middleware fights), schema-based
validation hooks, lower per-request overhead for a proxy whose p95 budget is 25ms added latency.
Express has no native streaming story and its v5 migration is still messy. **Reversal: L**
(server bootstrap + every route registration) — mitigated: route handlers take (envelope, ctx)
pure functions; only the thin Fastify layer would be rewritten.

## D-003 — Port 8220 (block 8220–8229)

Suite port registry audit (appliance manifests, env templates, compose publishes, dev mocks):
8090, 8200, 8210–8212, 8299–8301, 5171–5198 are taken. The plan's original 8300 collided with
Vibe-1099's dev `mock-tax1099`. 8220s is the next free per-app block after 1099's 8210s.
Dev compose host ports: postgres 55433, redis 56380 (offset +1 from 1099's to allow parallel
dev stacks). **Reversal: S** (env default + compose + appliance manifest).

## D-004 — Service name `vibe-ai-router`, subdomain `airouter`

Container/service: `vibe-ai-router` (GHCR: `ghcr.io/kisaesdevlab/vibe-ai-router`). Caddy route:
`airouter.<domain>` — admin UI only; app traffic stays on the internal docker network
(`http://vibe-ai-router:8220`) and is never exposed through Caddy. Chosen over `ai.<domain>` to
avoid implying a general AI endpoint for humans. **Reversal: S**.

## D-005 — Node 24 runtime (Phase 15B decision; superseded Node 20 plan pin)

Originally node:20-alpine per plan ([Q-002]). Kurt chose Node 24 in the 15B review to match
the newer suite apps (Vault, 1099) — Docker base node:24-alpine, `engines.node >= 24`,
CI on 24. **Reversal: S** (bump base image back).

## D-006 — Hand-authored up/down SQL migrations, custom runner

Phase 1.16 requires up → down → up reversibility in CI; drizzle-kit generates forward-only
migrations. Runner is ~100 lines (db/migrate.ts), migrations are `NNNN_name/{up,down}.sql`
directories, drizzle schema remains the type source of truth and drizzle-kit stays available
for diff assistance. **Reversal: M** (could adopt drizzle-kit + a down-file convention later).

## D-007 — postgres.js driver (not node-postgres)

Single modern driver for both the app (via drizzle-orm/postgres-js) and the migration runner;
tagged-template parameterization by default. **Reversal: S**.
