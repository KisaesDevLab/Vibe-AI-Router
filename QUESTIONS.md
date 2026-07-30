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

## Phase 8

- [Q-029] Does cloud_allowed get scrubbed? → **YES — every cloud-bound request is scrubbed
  regardless of tier** → 8.2 says cloud-bound; a scrubber hit on a "no client data by
  construction" class means the construction failed — blocking is the protective act → **S**
- [Q-030] Bare 9-digit SSN detection → **only with ssn/social-security/taxpayer-id keyword in
  the preceding 40 chars** → unqualified 9-digit runs are overwhelmingly invoice/order ids;
  dashed/spaced forms always match → **S**
- [Q-031] Phone-shaped 3-2-4 strings (e.g. 555-12-3456) → **treated as SSNs** → structural
  determinism is the contract; block message names the TYPE so operators can react → **S**
- [Q-032] Scrub-vs-route ordering (scrub needs to know cloud-bound before route runs) →
  **stageScrub runs the same pure selectModel() the route stage uses** → keeps plan order
  auth→policy→scrub→route while deciding exemption on the true selected target → **S**

## Phase 9

- [Q-033] Ledger rows for pre-auth failures? → **no row (firm unattributable); logs + Phase 10
  rate limiting cover the surface** → firm_id is NOT NULL by design; "exactly one row per
  request" reads as per *authenticated* request → **S**
- [Q-034] Usage token semantics → **normalized DISJOINT (promptTokens excludes cached);
  OpenAI-family adapters subtract, wire responses re-add** → cost math needs one convention;
  Anthropic is natively disjoint → **S**
- [Q-035] Missing cache pricing rates → **fall back to full input rate (conservative
  over-charge, never under)** → deterministic-cost principle prefers overstatement to silent
  discounts → **S**
- [Q-036] Task-class budgets (policy.monthly_budget_cents) → **indexed ledger SUM at request
  time, not budgets_state** → budgets_state enum has firm/app/user; adding a 4th scope is a
  migration; (task_class_id, ts) index keeps the SUM cheap → **M**
- [Q-037] Monthly rollover job (9.4) → **not needed: budgets_state rows are keyed by period
  (yyyymm); a new month naturally starts at zero** → **S**

## Phase 10

- [Q-038] Redis-backed breaker/rate-limit state → **in-memory only, behind clean class
  interfaces** → the appliance is single-container (one process); Redis state buys nothing
  until multi-instance, and the interfaces (CircuitBreaker/RateLimiter/LoadShedGuard) are the
  seam for a Redis impl later → **M**
- [Q-039] Load-shed rejection code → **rate_limited (429, Retry-After 1)** → clients already
  handle 429 with backoff; 502 would misread as provider fault → **S**
- [Q-040] Breaker may not open on a success sample even if the window is failure-heavy →
  fresh evidence of health should never trip the circuit (chaos-test-caught) → **S**
- [Q-041] Fallback on RETRYABLE failures too (after retries exhausted), not only non-retryable
  → plan 10.1/10.3 read together: retries first, then advance; stranding the request after
  retries when a fallback exists serves nobody → **S**

## Phase 11

- [Q-042] Admin auth mechanism → **local email+password (scrypt) + signed in-memory sessions,
  SameSite=Strict + x-vibe-admin header for mutations** → suite-wide SSO is an explicit
  backlog item; appliance-local auth unblocks the UI; sessions reset on restart unless
  SESSION_SECRET set → **M** (swap to suite SSO later behind the same /admin-api/auth surface)
- [Q-043] Password dependency → **Node scrypt, no argon2 native module** → zero native build
  deps in the container; scrypt N=16384 is adequate for a LAN-only admin login → **S**
- [Q-044] UI stack → **plain React 18 + hand-rolled hash routing + one CSS file, zero UI
  libraries** → smallest attack/maintenance surface for an appliance; 56KB gzip total → **S**
- [Q-045] Task-class sensitivity widening → **allowed ONLY via PATCH /admin-api/task-classes
  (admin session), always audited with before/after** → registration/import can never widen;
  someone must be able to, deliberately → **S**
- [Q-046] Test-prompt endpoint runs the pipeline with a server-side trusted auth context
  (admin session substitutes for an app token) → the wizard→policy→request→ledger smoke needs
  a first-party path; it ledgers as app "admin-ui" → **S**

## Phase 12

- [Q-047] 12.4 says "migrate Vibe Trial Balance" — that code lives in the separate
  trial-balance-app repo with its own release state → **router-side migration surface built
  completely (SDK, classes, policies, shadow harness, playbook); the TB-repo call-site swap
  is staged as a Phase-15-gated change rather than editing a sibling production repo mid-
  autonomous-build** → the plan itself keeps TB's direct path flagged until 15.8, so the swap
  lands in the same window; blast radius of an unsupervised cross-repo edit outweighs the
  sequencing gain → **M** (the swap itself is a ~2-file change per the playbook)
- [Q-048] Shadow harness normalization → **JSON-parse + key-sort before comparing; raw text
  otherwise** → whitespace/key-order noise is not divergence for structured-output classes;
  report records hashes only → **S**

## Phase 13

- [Q-049] Cache hits and the one-row-per-request invariant → **cache hits WRITE a ledger row**
  (zero-ish usage from the cached response's serve, cost recomputed) → invariant (d) stays
  absolute; dashboards see true request volume → **S**
- [Q-050] Audit retention → **immutable forever; the retention setting covers usage_ledger
  only** → the DB trigger blocks audit deletes by design; purging compliance evidence should
  require a deliberate future migration, not an env var → **S**
- [Q-051] /metrics auth → **unauthenticated, internal-network only, never routed via Caddy**
  → standard Prometheus posture; documented in appliance.md with an explicit "do not expose"
  note; contains no message content by construction → **S**

## Phase 14

- [Q-052] Admin login throttling/lockout → **not implemented** → LAN-only vhost behind Caddy;
  scrypt cost already slows brute force; flagged for review — a token-bucket on /auth/login
  is a 20-line add if wanted → **S**
- [Q-053] Load-test methodology → **added-latency delta vs direct-to-mock baseline, uniformly
  paced in-process harness** → burst-firing 50 simultaneous requests measured queueing (first
  run "604ms p95" was harness artifact); the 25ms budget explicitly excludes upstream → **S**
- [Q-054] 1-hour memory-stability soak (14.4) → **60s run on dev box (rss +89MB incl. harness
  allocations, 0 errors); full soak scheduled for first appliance deploy alongside the live
  vibellm smoke (Q-011)** → dev-box hour-long soak measures the wrong hardware anyway → **S**
- [Q-055] drizzle-orm high advisory (GHSA-gpj5-g38j-94v9, SQL-identifier escaping) → upgraded
  0.44→0.45.2, full suite green; CI now gates on `pnpm audit --audit-level high` → **S**

## Phase 15 (operator decisions — Kurt, 15B Q&A 2026-07-27)

- [Q-056] Scrubber firm default → **CHANGE block→redact per Kurt** → protected numbers become
  [TYPE] tokens before cloud transmission; block stays one click away per firm; invariant (c)
  test now sets block explicitly → **S**
- [Q-057] Runtime → **CHANGE Node 20→24 per Kurt** → suite standardization (Vault/1099);
  image/engines/CI updated, full suite re-verified → **S**
- [Q-058] TB call-site swap (MIG-1) → **deferred by Kurt from the 15C window to its own
  scheduled ticket** → 1.0.0 ships without it; trial-balance-app keeps its direct path until
  MIG-1 lands (direct-path flag removal, plan 15.8, moves with MIG-1) → **S**
- All other agenda items: **KEEP as built** (recorded in REVIEW-PACKET.md verdict table).
- [Q-059] Post-1.0.0 operator directive: **all app migrations ON HOLD until the router passes
  multiple QA rounds** → QA rounds A/B/C executed 2026-07-27 (QA-REPORT.md: 5 findings found
  and fixed, incl. one High money-correctness defect in cache-hit ledger rows); hold remains
  until explicit sign-off → **S**
- [Q-060] DigitalOcean Gradient serverless inference: preset of `openai_compat` vs own
  provider kind? → **own kind `digitalocean`, reusing the openai-compat adapter** → routing
  resolves the firm's provider BY KIND (`engine.providerFor`), so a second `openai_compat`
  row is unreachable next to OpenAI/Groq — a preset would work only for firms with no other
  openai-compat cloud provider and silently misroute otherwise. Migration 0003 adds the enum
  value; its down.sql removes DO rows and rebuilds the type (downs are destructive by repo
  contract — 0001's drops the schema). Base URL https://inference.do-ai.run/v1, Bearer
  model-access-key, wire protocol identical to OpenAI (flavor `generic`) → **M** (enum value
  + kind unions; reversal = migration down)
- [Q-061] DO model catalog source: pollute the pinned LiteLLM snapshot vs curated first-party
  file? → **separate `data/digitalocean-models.json`, merged into the vendored feed at load**
  (LiteLLM carries no digitalocean entries; hand-curated rows don't belong in a third-party
  snapshot whose provenance is "pinned upstream"). 14 open-source models with DO's published
  per-MTok pricing (docs retrieved 2026-07-29); kimi-k3 omitted — no published context
  window. Cross-file key collisions refuse loudly. Commercial Anthropic/OpenAI models on DO
  are NOT listed — those route through their own kinds with the firm's own keys, which is
  the §7216 story → **S**
- [Q-062] DO capability flags with no per-model documentation (DO documents tool calling for
  its commercial models only) → **conservative: tools/json_schema unset (= false), vision
  only for documented-multimodal Kimi K2.5/K2.6, caching only where a cached-input price is
  published** → config-time gating refuses DO models for classes requiring undeclared
  capabilities (fail closed, invariant #7); operators unlock per model via
  capability_overrides after verifying against their account → **S**
- [Q-063] Router adoption posture in apps: hard swap (Q-047) vs dual-mode? → **operator
  decision 2026-07-29 (Kurt): dual-mode PERMANENTLY — router is an option, direct path is a
  first-class mode** → some apps ship as single-install standalone instances with no router
  in the deployment; invariant #1 ("apps never hold provider keys") is hereby scoped to
  appliance deployments in router mode. Supersedes Q-047's "retire direct path" / plan 15.8.
  Details: docs/router-option-addendum.md (D2–D6 still open) → **S**
- [Q-064] Addendum decisions D2-D6 → **operator verdict 2026-07-29 (Kurt): go with the
  recommendations** → D2 new appliance installs default VIBE_AI_MODE=router once an app's
  driver ships; D3 automate app-token minting during `vibe enable` (manual minting is the
  step operators skip); D4 R1 Anthropic-native passthrough APPROVED for the backlog (Phase D
  gate for TRC chat); D5 GLM-OCR stays direct (local tier, revisit as its own ticket); D6
  Q-059 hold LIFTED for Phase A (Payroll-Time, Calculators) → **S**
- [Q-065] SDK distribution to app repos (no npm auth available) → **pnpm repos: git
  dependency pinned to a tag (github:KisaesDevLab/Vibe-AI-Router#sdk-v0.2.0&path:packages/sdk,
  prepare script builds on install); npm-workspace repos: vendor the single dependency-free
  file with a provenance header** → the SDK is deliberately one file with zero deps precisely
  to make vendoring safe; GitHub Packages rejected (requires auth even for public installs,
  breaking standalone installs); npm publish deferred until credentials exist → **S**
