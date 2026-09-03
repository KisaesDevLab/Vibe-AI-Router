# DECISIONS.md — architecture decision record

Reviewed by Kurt in Phase 15. Format: decision → rationale → reversal cost.

## D-001 — License: BSL 1.1 (Apache 2.0 at 4-year change date) — **SUPERSEDED by D-008**

Matches Vibe Trial Balance. Firm-hosted commercial product; BSL blocks competitive hosted
resale while converting to genuinely open source on a clock. **Reversal: S** (swap LICENSE +
headers before 1.0).

> Superseded 2026-08-28 by **D-008** (PolyForm Small Business 1.0.0), operator-directed.
> Recorded rather than rewritten: REVIEW-PACKET.md item 6c carries Kurt's Phase-15 "KEEP"
> verdict on this decision, and that record stays accurate as of the date it was made.

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

## D-008 — License: PolyForm Small Business 1.0.0 (supersedes D-001)

Operator-directed, 2026-08-28. Replaces BSL 1.1. Two consequences are material and were not
carried over from D-001, so they are recorded explicitly rather than left to be discovered:

1. **No change date.** BSL converted to Apache 2.0 four years after each release. PolyForm has
   no such clock — the software never becomes open source by the passage of time. Any future
   open-sourcing is now a deliberate act, not a default.
2. **Production use is gated on licensee SIZE, not on what they do with it.** BSL permitted all
   production use except offering a competing hosted service. PolyForm permits production use
   only for companies with fewer than 100 total employees and contractors AND under
   1,000,000 USD (2019, CPI-adjusted) revenue in the prior tax year. A CPA firm above either
   threshold is not licensed to run the appliance and needs a separate commercial licence.
   The competing-hosted-service carve-out is no longer the operative restriction; firm size is.

Applies to `packages/sdk` (`@kisaes/vibe-ai-client`) as well, which every Vibe app imports —
the SDK is not licensed more permissively than the router.

Note the suite is no longer uniform: Vibe Trial Balance remains BSL 1.1. D-001's rationale
("matches Vibe Trial Balance") no longer holds for this repo.

**Reversal: S** (swap LICENSE + the `license` field in both package.json files + README/CLAUDE
references). Note that reversal is cheap MECHANICALLY but not legally — anyone who received a
copy under PolyForm keeps those terms for that copy.
