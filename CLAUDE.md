# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

**All phases 0–14 + 15A built and 15B reviewed** (2026-07-26/27, one autonomous pass; see
`PHASES.md` per-item status, `STATE.md` verification journal, `QUESTIONS.md` 58 decisions,
`REVIEW-PACKET.md` with Kurt's recorded verdicts). v1.0.0 tagged after 15C applied the review
outcomes: scrubber default **redact** (Q-056), **Node 24** runtime (Q-057), TB call-site swap
deferred to ticket MIG-1 (Q-058, docs/migration-tickets.md).

**Not yet run on the real appliance:** live vibellm smoke (`scripts/smoke-live.ts`, Q-011),
1-hour memory soak (Q-054), real shadow-diff report. `VIBE-AI-ROUTER-BUILD-PLAN.md` remains
the scope source of truth; reviewed decisions are LOCKED — do not relitigate.

Suite context: this replaces the scrapped **Vibe Shield** concept (`../Vibe-Shield/`) with
routing-layer enforcement instead of a separate guard product.

## Build process — autonomous, no gates

Phases 0 → 14 run **without stopping for human review**. Phase 15 is the sole human touchpoint.
This inverts the usual instinct to ask; do not stall mid-build waiting for Kurt.

- **Decision Protocol:** at any decision point — (1) choose the safest defensible default
  (local-first, fail-closed, restrictive over permissive), (2) implement it, (3) append to
  `QUESTIONS.md` as `[Q-nnn] question → default chosen → rationale → refactor cost (S/M/L)`.
  Any **L**-cost decision must additionally sit behind a config flag or interface so Phase 15 can
  reverse it cheaply.
- **Definition of done per phase:** checklist complete, unit tests for new logic, integration test
  for one happy path + one failure path, `STATE.md` updated, no `any` introduced, migration
  reversible. Run the Gap-Prevention Checklist (end of the build plan) at every phase boundary.
- **Contract-first:** anything another phase consumes (envelope, adapter contract, SDK) is frozen
  as `.d.ts` + a doc in the phase that introduces it. Later phases extend, never break.

## Core invariants — do not violate

These are the product. Several are enforced by `/test/invariants` in CI from Phase 8 onward.

1. **Apps never hold provider keys.** All AI traffic from every Vibe app goes through the router.
   No exceptions, no "temporary" direct calls.
2. **Prompt bodies are never persisted.** Logs, ledger, and audit rows store metadata and hashes
   only. Audit `detail` jsonb is zod-validated per event type so it *structurally* cannot carry
   message content. Pino redaction paths exist from Phase 0.10 — before any AI traffic exists.
3. **Fail closed.** Scrubber errors, policy-lookup failures, missing `X-Vibe-Task-Class`, or an
   unknown task class **block** cloud egress. Never fall through to allow.
4. **Local-first never regresses.** The appliance must stay fully functional with only the local
   tier (Ollama/vibellm); cloud providers are opt-in per firm. Zero-cloud mode has an automated
   smoke test in the gap checklist.
5. **`local_only` task classes can never reach a cloud adapter** — including via fallback chains.
   Every fallback hop re-runs capability *and* sensitivity checks.
6. **Policy is enforced server-side.** The admin UI is a convenience; the router re-validates every
   request independently of what the UI allowed to be saved.
7. **Capability gating happens twice** — at config time (a model lacking tool calling can't be
   saved to a tool-calling task class) and at request time (reject with a clear error, never
   silently degrade).
8. **Exactly one ledger row per request**, completed or failed, written in the pipeline's finally
   block, idempotent by request ID. Unknown pricing is flagged `cost_unknown=true` — never silently
   zero.
9. **One internal message format.** Policy, scrubbing, ledger, and fallback logic operate only on
   the internal envelope and never see provider-specific shapes. Adapters translate at the edge.
10. **No plaintext credentials anywhere** — no plaintext DB column, no read-back HTTP endpoint, and
    none in logs, error messages, or API responses (asserted at runtime and by grep in tests).

## Stack & conventions

- Node.js 24 (Q-057; plan said 20), TypeScript strict, **Fastify** (chosen over Express for first-class SSE streaming and
  lower proxy overhead), Drizzle ORM, PostgreSQL 16, Redis 7 (optional — rate limiting + response
  cache, always with an in-memory fallback), React 18 + Vite admin UI, pnpm, Vitest, tsx.
- Docker single container + the shared appliance Postgres. Default port **8220** (block
  8220–8229 reserved for this app in the suite port table; supersedes the plan's 8300, which
  collides with `Vibe-1099`'s dev `mock-tax1099`). Record in DECISIONS.md at Phase 0.8.
- License: BSL 1.1 → Apache 2.0 at 4 years, matching Vibe Trial Balance. Confirm in Phase 0.
- Conventional commits. Env config via zod — **refuse to boot on invalid config**; every env var
  documented (the gap checklist fails on an undocumented one).
- Redis is always optional: every Redis-backed feature (breaker state, rate limits, cache) needs an
  in-memory path.

## Architecture

Target layout is in the build plan (§Repo Layout). The shape that matters:

**Request pipeline** (`/src/gateway`) is an explicit ordered middleware chain, each stage a pure
testable function:

```
auth → resolve task class → policy → scrub → route → adapt → ledger → respond
```

**Task class is the central abstraction.** Apps declare task classes at boot (idempotent,
version-stamped); each carries a `sensitivity` (`local_only | cloud_deidentified | cloud_allowed`)
and a `requires` capability set (tools / json_schema / vision). Policy binds `(firm, task class)` →
default model + allowed models + fallback chain + limits. Requests name a task class via the
`X-Vibe-Task-Class` header — everything else (model choice, scrubbing, budget scope, audit
attribution) derives from it.

**Public surface** is OpenAI-compatible: `POST /v1/chat/completions`, so the official `openai` npm
client works as a contract test client. Apps consume it through `@kisaes/vibe-ai-client`
(`/packages/sdk`) — that package contains zero provider SDKs.

**Two adapter families**, one contract (`/docs/adapter-contract.md`): openai-compat (OpenAI, Azure,
Ollama, Groq, DeepSeek — Azure's deployment-name-as-model quirk lives on the provider record) and
Anthropic native (Messages API, prompt caching breakpoints, extended thinking). A Phase 4 test
asserts the same envelope through both families yields structurally identical `AIResponse`.

**Model catalog** syncs from LiteLLM's pinned `model_prices_and_context_window.json`. Sync is
additive and flagging only — never auto-deletes; missing models are marked `deprecated`. Pricing
appends to `model_pricing` history (`effective_from`) so historical ledger rows can be recomputed
against the pricing in force at request time.

**Schema is created whole in Phase 1** (16 tables) so later phases don't fight migrations.

## Non-obvious decisions

- **Streaming fallback rule:** fallback is permitted only *before* the first content chunk reaches
  the client. After that, fail the stream cleanly with an error event — never splice providers
  mid-stream.
- **Scrubber runs on cloud-bound requests only** (local tier exempt), across all message text
  including tool results. Block mode returns match *types* only, never matched values. Redact mode
  is one-way and applies to the outbound copy — the in-memory envelope is untouched, and there is
  no de-tokenization.
- **Client disconnect must abort upstream within 1s** — orphaned streams burn firm tokens.
- **`max_tokens` is never unset on cloud calls**; the request value is clamped to the policy
  override or task-class default (Anthropic mandates the field regardless).
- **When usage is missing from a provider**, estimate (js-tiktoken / char heuristic) and flag it —
  the ledger distinguishes measured from estimated from unknown.
- **Sensitivity assignments are the most compliance-critical artifact.** Phase 7 generates
  `SENSITIVITY-REVIEW.md` (app / task class / sensitivity / rationale) and it is item #1 on the
  Phase 15 agenda. Until reviewed, when in doubt: `local_only`.
- **SSRF is a real threat here** — custom `base_url` on provider records is user-supplied. Cloud
  kinds get private-range denial; local kind is pinned to LAN config (Phase 14).
- **Master key is excluded from the Vibe Vault backup set** by design, with a documented
  separate-custody procedure.

## Compliance frame

The product story is "the firm's own keys, the firm's own providers, no intermediary" — §7216 and
engagement-letter language depend on it. The router must never become a party that holds client
data or resells inference. Firm-facing deliverables include a "where your data goes" one-pager
mapping each task class to local vs. cloud.
