# QUESTIONS.md — append-only decision log (Decision Protocol)

Format: `[Q-nnn] question → default chosen → rationale → refactor cost if reversed (S/M/L)`.
Grouped by phase. This file is the Phase 15 review agenda.

## Phase 0

- [Q-001] Migration tooling: drizzle-kit forward-only vs reversible pairs? → **Hand-authored
  up/down SQL pairs + ~100-line runner** → plan hard-requires up→down→up in CI (1.16);
  drizzle-kit cannot express down migrations → **M**
- [Q-002] Node 20 (plan) vs Node 24 (rest of recent suite)? → **Node 20 LTS in Docker,
  engines >=20** → plan-pinned; no >20 APIs used, so a later bump is a one-line change → **S**
- [Q-003] Admin UI exposure: Caddy subdomain vs LAN-only port? → **Caddy subdomain `airouter`
  for the admin UI only; app-facing API never routed through Caddy** (internal docker DNS) →
  smallest public surface consistent with "non-technical admin can use a browser" → **S**
- [Q-004] Dev DB host ports? → **55433/56380** → 1099 dev stack owns 55432/56379; both stacks
  must run simultaneously during Phase 12 TB/app migrations → **S**

## Phase 1

- [Q-005] `audit_log.event` pg enum vs text? → **text + app-side zod event registry** → the
  event vocabulary grows every phase (fallback hops, breaker transitions, admin mutations);
  ALTER TYPE churn on an append-only table is worse than app-layer validation → **S**
- [Q-006] Columns added beyond plan text → **users.email/display_name (Phase 11 auth),
  provider_credentials.status/grace_until (Phase 6 rotation), providers.model_mapping (Azure
  3.4), models.capability_overrides (5.5), ledger.cost_estimated + request_id (9.2/9.3)** →
  schema-whole-up-front is the phase's stated purpose; avoids later migration churn → **S**
- [Q-007] Local model cost representation? → **explicit $0 pricing rows** → local is genuinely
  zero-cost; `cost_unknown` must stay reserved for missing pricing (principle 7) → **S**

## Phase 2

- [Q-008] Plan taxonomy has no code for malformed bodies → **added `invalid_request` (400)** →
  every OpenAI-compatible surface needs it; mapping unknowable inputs to `unknown` (500) would
  misreport client bugs as server faults → **S**
- [Q-009] Missing/unknown task class error code? → **`policy_blocked` (403)** → it is a policy
  decision (fail closed), not a syntax error; distinguishable via message text → **S**
- [Q-010] Client-disconnect detection → **response `close` with `writableFinished=false`**
  (req.raw `close` fires on normal completion in Node ≥18 and falsely aborts) → **S**

## Phase 3

- [Q-011] 3.10 requires a live Ollama completion; dev box has none → **verified against
  in-process OpenAI-shaped mock; scripts/smoke-live.ts ships as the live-verification vehicle
  for first appliance deploy** → identical wire format; risk is Ollama-specific quirks already
  encoded from docs (no stream_options, /api/show probe) → **S**
- [Q-012] Flavor detection heuristic (host patterns) vs explicit provider field? → **heuristic
  with `generic` fallback** → zero-config for the common cases; Azure detection is robust
  (*.azure.com); a provider `flavor` column can be added without breaking anything → **M**
- [Q-013] Unknown finish reasons → **normalize to `stop`** → unknown reasons overwhelmingly
  mean "completed normally" on compat gateways; `error` would spuriously fail requests → **S**

## Phase 4

- [Q-014] json_schema on Anthropic: beta output_format vs forced tool? → **forced synthetic
  tool (`emit_<name>`) whose input_schema is the schema; tool_use translated back to content**
  → works on every Claude model with no beta headers; deterministic; structured-output beta can
  replace it later behind the same envelope surface → **M**
- [Q-015] Caching breakpoint strategy → **3 fixed breakpoints: last system block, last tool,
  last block of second-to-last message; per-task-class opt-in via ExecuteContext.promptCaching**
  → deterministic, ≤4-breakpoint limit respected; smarter windowing is a tuning question → **S**
- [Q-016] Thinking text exposure → **surfaced as AIResponse.thinking (transient only), thinking
  deltas NOT relayed into the SSE stream** → callers get it non-streaming when enabled;
  streaming relay would require an envelope chunk-type extension — deferred → **S**

## Phase 5

- [Q-017] "Pinned URL + checksum" sync source → **vendored filtered snapshot shipped in-repo
  (data/litellm-prices.json, provenance in data/VENDOR.md); nightly sync reads the vendored
  file, no network** → supply-chain-safe, offline-appliance-safe; refresh is a release action;
  optional remote refresh can be added behind CATALOG_SYNC_URL later → **S**
- [Q-018] Manual sync endpoint needs auth before Phase 11 exists → **/admin/* bootstrap surface
  gated by ADMIN_BOOTSTRAP_TOKEN (≥16 chars, constant-time compare); routes NOT REGISTERED when
  unset** → fail closed; Phase 11 replaces with session auth → **S**
- [Q-019] Audit writer needed before Phase 8 → **minimal registry-based writer in
  src/protect/audit.ts (zod-validated detail per event type)** → catalog events land in the
  real audit_log from day one; Phase 8 extends the registry rather than rewriting → **S**

## Phase 6

- [Q-020] Staged-credential representation → **`grace` + grace_until NULL = staged; grace_until
  set = demoted/expiring** → avoids a 4th enum value + migration; semantics documented in
  service.ts and runbook → **S**
- [Q-021] MASTER_KEY unset behavior → **boot continues in local-only mode (cloud credential
  ops 503, keyless providers serve)** → zero-cloud mode must never regress (principle 2);
  requiring a master key for a fully local appliance would do exactly that → **S**
- [Q-022] Health thresholds → **window 50, min 10 samples, degraded ≥20%, down ≥50%** →
  sane defaults pending real traffic; Phase 10 breaker consumes the same window → **S**
- [Q-023] Active health probe interval (6.6 "optional") → **deferred to Phase 13** (metrics
  loop is the natural home; passive + manual test cover Phase 6 acceptance) → **S**

## Phase 7

- [Q-024] Advisory `model` in request body honored how? → **only when in the allowed set AND
  passing validation; otherwise the policy default serves silently** (ledger records
  requested vs served) → apps stay portable; erroring would break OpenAI-SDK ergonomics → **S**
- [Q-025] App-registered NEW task classes → **always local_only** (pack entries keep curated
  tier); registration NEVER changes existing sensitivity → most restrictive plausible default
  per plan; widening is an explicit admin action → **S**
- [Q-026] Role gating default when no role_policies row → **allowed** → the pack ships no
  role rows; deny-by-default would brick every request until Phase 11 UI exists; explicit
  deny rows still enforce → flag for Phase 15 → **S**
- [Q-027] Default pack scope: 14 classes across 8 suite apps invented from app domain
  knowledge → real apps will register their own keys in Phase 12+; pack seeds sensible tiers
  and the SENSITIVITY-REVIEW.md table → **S**
- [Q-028] Policy cache staleness vs catalog sync capability changes → **30s TTL backstop
  (no explicit invalidation on sync)** → worst case: a request within 30s of a sync uses
  just-stale capabilities; request-time validation still blocks true violations → **S**
