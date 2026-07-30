# Addendum — the router as an OPTION in each Vibe app

**Status: D1 DECIDED (2026-07-29, Kurt — see Q-063); D2–D6 open. The MIG hold (Q-059)
remains in force — nothing here authorizes app changes.** Prepared 2026-07-29 from a
call-site survey of all 11 suite repos.

## What this addendum changes

The migration playbook (`docs/migration-playbook.md`) and tickets (`docs/migration-tickets.md`)
assume a **hard swap**: provider SDKs deleted from each app, direct path retired after sign-off
(Q-047 / plan 15.8). This addendum replaces that posture with **permanent dual-mode**:

> Every AI-using app carries two drivers behind its existing provider interface — its current
> direct path and a router driver — selected by configuration. Dual-mode is the standing
> posture, not a transition: **some apps ship as single-install standalone instances, where no
> router exists to point at** (operator decision Q-063). Direct mode is therefore a first-class
> deployment mode, not a legacy scaffold, and there is no sunset date.

Deployment topology decides the mode:

| Topology | Mode | Why |
| --- | --- | --- |
| Appliance install (full suite) | `router` (recommended default) | the router is present, invariant #1 applies |
| Standalone single-install app | `direct` | there is no router in the deployment |
| Appliance install, firm opts out | `direct` (supported) | continuity during adoption |

**What dual-mode means for the invariants, stated honestly:** invariant #1 ("apps never hold
provider keys") is an **appliance-deployment invariant**, not a universal app invariant. The
"where your data goes" one-pager must describe the *active* mode per app. The compliance story
("no intermediary holds client data") is unchanged in both modes — in direct mode the app
itself holds the firm's key, in router mode the router does; both are the firm's own
infrastructure.

## Mode contract (identical in every app)

- `VIBE_AI_MODE=direct | router`. **Explicit, validated at boot**: `router` without
  `VIBE_AI_ROUTER_URL` + `VIBE_AI_TOKEN` refuses to start (matches the router's own
  refuse-to-boot-on-invalid-config convention). Default `direct` until the firm opts in;
  the appliance installer may default new installs to `router` once the app's driver ships.
- **No silent cross-mode fallback, ever.** A router outage in router mode surfaces as an
  error with a clear message — quietly falling back to direct would bypass scrubbing and the
  ledger with the raw prompt, which is worse than failing. (Failover *within* router mode is
  the router's own fallback-chain job.)
- In router mode the app **stops choosing models**. Task class is the only knob
  (`X-Vibe-Task-Class` via the SDK); model choice, fallback, budgets, and scrubbing derive
  from router policy. Each app's per-firm AI-settings UI collapses in router mode to a
  "Managed by Vibe AI Router" banner + deep link to the router console — those pages otherwise
  present dead controls, which reads as a bug.
- Task classes register at boot only in router mode (idempotent, version-stamped). New
  classes the pack lacks start `local_only` until widened (playbook rule 2).
- Attribution threads through every call: `userId`, `engagementRef`/`clientRef` where the
  app has them — this is what makes ledger dimensions and Time & Billing cost recovery work.
- App tokens: minted in the router console, delivered as `@VIBE_AI_TOKEN@`-style markers in
  each app's appliance env template (generate-once-preserve, same as passwords today).
  **Decision item D3** proposes automating the mint during `vibe enable`.

## Corrected app roster (survey 2026-07-29)

The MIG table's roster was aspirational; the survey found the actual surface. Three tiers:

### Tier 1 — clean seams, small blast radius (do first)

| Ticket | App | Reality found | Work |
| --- | --- | --- | --- |
| MIG-7′ | **Vibe-Payroll-Time** | 2 consumer call sites; provider fan-out already accepts `baseUrl` for all three providers (`backend/src/services/ai/provider.ts`). Anthropic-only tool use for punch edits — the router driver maps it to SDK `ToolDef`s | RouterProvider driver + mode flag + register `payroll_anomaly_review` (+ new `payroll_support_chat`). **0.5 d** |
| MIG-9 (new) | **Vibe-Calculators** | ~3 call sites; `endpoint` already configurable in `packages/llm/src/anthropic.ts`. Forced-JSON via tools | Driver + flag + new class `calc_loan_extract` (local_only start). **0.5 d** |
| MIG-1′ | **trial-balance-app** | ~18 sites but all behind `getLLMProvider()`; streaming SSE in support routes; vision in imports. Anthropic baseURL currently hardcoded — the driver bypasses that anyway | Flagship: shadow-diff harness already built for TB fixtures. Driver + flag + 3 pack classes (+ new classes for support chat/diagnostics). **1 d** (was 0.5 — dual-driver + streaming) |

### Tier 2 — real refactor or wide fan-out first

| Ticket | App | Reality found | Work |
| --- | --- | --- | --- |
| MIG-8′ | **Vibe-Time-Billing** | 14 inline `provider.complete()` calls in one 1400-line routes file; Anthropic URL is a module const (code change regardless). Also consumes `/v1/billing/usage` for cost recovery — unchanged, separate small feature | Extract a chokepoint first, then driver. `tb_invoice_narrative` exists; add classes for its other features. **1.5 d** |
| MIG-2′ | **myBooks** | ~39 invoking lines across 15 files behind a good `getProvider()` factory; vision + JSON mode; per-firm encrypted keys in DB | Driver at the factory + mode plumbed through per-firm config (mode is firm-level here, not just env). Pack has 2 classes; app has ~8 AI features → class gap analysis is most of the work. **1.5 d** |
| MIG-6′ | **Vibe-Transaction-Convertor** | 2,063-line `llm-client.ts` with raw Anthropic + Ollama paths; `ANTHROPIC_BASE_URL` seam exists and already switches auth header style for non-default hosts; tools-forced JSON (ADR-020); no streaming | Driver inside `buildProvider`; `txconv_statement_parse` exists. **1 d** |

### Tier 3 — blocked or premature (do NOT schedule yet)

| Ticket | App | Why |
| --- | --- | --- |
| MIG-4′ | **Vibe-Tax-Research-Chat** | The only Anthropic-*exclusive* app, and it lives on surface the router does not expose: beta headers, server-side tools (web_search / web_fetch / code execution), skills containers, prompt-caching breakpoints, `/v1/models` discovery. Its `SHIELD_URL` seam proves the intent, but pointing it at the router today would break every advanced feature. **Split**: background jobs through `callClaude()` (3 call sites, plain completions) can route now as `taxresearch_memo_draft` etc.; the streaming chat with server tools stays direct until router backlog item **R1** ships. Embeddings (Voyage) additionally needs **R2**. **1 d now + R1/R2-gated remainder** |
| MIG-3 | **Vibe-1099** | **No AI code exists.** The `v1099_*` pack classes stay (they cost nothing and pre-declare sensitivity); the ticket becomes "adopt router-first when the feature is built" — no migration. **0 d** |
| MIG-5 | **Vibe-Connect** | Same — no AI code. `connect_doc_summarize` stays in the pack as the pre-declared boundary. **0 d** |
| — | **Vibe-Investments** | Greenfield stub (`ai-research` package is one line). **Router-only from day one** — never grows a direct path, first pure consumer of `@kisaes/vibe-ai-client`. |

## Router-side prerequisites (new backlog items)

- **R1 — Anthropic-native passthrough (`/v1/messages`).** Required for Tax-Research-Chat's
  chat surface (betas, server tools, containers, cache breakpoints). Policy/scrub/ledger run
  on the internal envelope as today; the adapter passes through what it cannot translate.
  Substantial: new public surface + envelope extensions. Estimate **3–4 d**; without it,
  MIG-4′ stays split.
- **R2 — Embeddings endpoint** (`/v1/embeddings`). Needed by Tax-Research-Chat RAG; DO and
  OpenAI-compat providers already serve it upstream. **1–2 d.**
- **R3 — SDK conveniences.** Survey-driven gaps in `@kisaes/vibe-ai-client`: forced-JSON
  helper matching the apps' tools-as-JSON pattern, and an Anthropic-`Messages`-shaped shim to
  shrink per-app driver code. **0.5–1 d**, amortized across every ticket.
- **R4 — decision: front GLM-OCR?** Four apps call `vibe-glm-ocr` directly (each with its own
  client + env family). It is local-tier (no egress, no keys), so leaving it direct violates
  no boundary; routing it would unify cost/audit visibility and retire four bespoke clients.
  Recommendation: **leave direct in this phase**, revisit as its own ticket once option-mode
  lands — OCR volume behind the router's shed queue needs its own latency look first.

## Sequencing

```
W0 (router repo): R3 SDK helpers → release; R2 embeddings if MIG-4′ scheduled
Phase A: MIG-7′ Payroll-Time → MIG-9 Calculators        (quick wins, prove the pattern)
Phase B: MIG-1′ trial-balance-app                        (flagship + shadow-diff report)
Phase C: MIG-8′ Time-Billing → MIG-2′ myBooks → MIG-6′ TxConvertor
Phase D: MIG-4′ TRC jobs now; TRC chat after R1
Continuous: 1099 / Connect / Investments adopt router-first when their AI features are built
```

Total app-side effort ≈ **6 d** across Phases A–C, +1 d MIG-4′ jobs; R1 adds 3–4 d router-side
if approved. Each ticket is independently shippable and reversible (flip the flag back).

## Acceptance criteria (replaces the hard-swap list, per ticket)

1. Both modes pass the app's existing AI feature tests; **direct mode behavior is untouched**
   (diff of direct-path code ≈ zero outside the resolver).
2. Router mode verified end to end: task classes registered at boot; one live request per
   feature shows a ledger row with correct app/task-class/user/client dims; scrubber events
   audited for cloud-bound classes.
3. Boot validation: `VIBE_AI_MODE=router` without URL/token refuses to start; router
   unreachable at request time → clear error, **no fallback to direct**.
4. Shadow-diff report attached where the app had a direct path (harness exists; TB fixtures
   ship in the router repo).
5. Appliance env template carries `VIBE_AI_MODE` + `@VIBE_AI_ROUTER_URL@` + `@VIBE_AI_TOKEN@`;
   provider SDK deps **stay** (dual-mode) but are quarantined behind the direct driver.
6. App settings UI shows the managed-by-router state instead of dead model pickers.

## Decision items for the operator

- **D1** — ✅ **DECIDED (2026-07-29, Kurt / Q-063): dual-mode is the standing posture,
  permanently** — some apps ship as single-install standalone instances where no router
  exists. Supersedes Q-047's "retire the direct path". No sunset dates.
- **D2** — Appliance default for *new* installs once a driver ships: `router` or `direct`?
  (Recommendation: `router` — new installs have no direct-path muscle memory to preserve.)
- **D3** — Automate app-token minting during `vibe enable <app>` (enable script calls the
  router admin API with credentials it already holds), or keep manual console minting?
  (Recommendation: automate; manual minting is the step operators will skip or botch.)
- **D4** — R1 (Anthropic passthrough): build it, or accept TRC chat staying direct
  indefinitely? This is the largest single line item and only one app needs it.
- **D5** — R4 GLM-OCR: confirm leave-direct recommendation.
- **D6** — Lift or keep the Q-059 hold for Phase A once D1–D3 are decided.
