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
- [Q-066] MIG-1 trial-balance-app task-class mapping (15 aiComplete sites + 1 stream) →
  **3 pack classes reused (tb_classification for csv/tax-line/bank-txn/account-number
  suggestion; tb_doc_extract for TB PDF import incl. chat+verify; tb_research_summary for
  the zero-client-data model-pricing fetch) + 3 NEW classes (tb_bank_statement_extract —
  full statements are account numbers + transaction detail throughout, txconv precedent,
  requires vision+json_schema, defaultMaxTokens 32768; tb_support_chat — streaming KB chat;
  tb_diagnostics — TB/GL observations), all three start local_only until widened** →
  driver fails closed on any call site that omits taskClass (an unmapped site must not ride
  a default class). NOTE for operators: TB call sites request up to 8192 output tokens on
  tb_classification (pack default clamps at 2048) — raise the policy max-token override if
  truncation shows up in ai_usage_log → **S**
- [Q-067] MIG-8 Time-Billing class mapping (16 features) → **3 classes: pack
  tb_invoice_narrative (suggest-description, prebill-narrative, reason-code-suggest) + NEW
  timebill_practice_analytics (nine analytics/pricing/NL-translation features) + NEW
  timebill_support_chat (staff + client-portal KB chat), new ones local_only** → app-side
  egress gate/credentials/budget go inert in router mode (ai_request_log rows carry
  provider=VIBE_ROUTER at cost 0 — the router ledger owns cost); unknown features fail closed
  before any wire traffic. Time-Billing has NO appliance manifest — router mode is
  env-documented in its repo for multi-app deployments → **S**
- [Q-068] MIG-6 TxConvertor scope: which paths route? → **policy-driven TEXT passes only
  (extraction+repair → pack txconv_statement_parse; cleanse/category → NEW txconv_enrichment;
  check text-parse → NEW txconv_check_resolve); the forced-local vision/OCR paths (GLM-OCR
  pages, check-image reads) stay direct in BOTH modes** → page images never leave the box
  (ADR-023/025), so there is no boundary for the router to enforce there; RouterProvider's
  vision surfaces throw by design. Worker's primary/secondary fallback order collapses to the
  router (failover within router mode is the router's fallback-chain job) → **S**
- [Q-069] MIG-2 myBooks class gap (8 features vs 2 pack classes) → **6 NEW local_only classes:
  mybooks_bill_extract (distinct schema from receipts), mybooks_doc_classify,
  mybooks_statement_extract (stage-2 + check reads), mybooks_vendor_enrich, mybooks_chat,
  mybooks_report_narrative; judgment review rides mybooks_txn_categorize (same transaction
  data boundary)** → the pinned-local qwen extraction pipeline + GLM-OCR keep forceDirect in
  both modes; myBooks' two-tier consent + per-company task toggles stay app-side (extra
  governance on top of router policy, not instead of it) → **S**
- [Q-070] MIG-4 TRC job routability → **9 of 10 background jobs route (content_meta /
  authoring / memo_draft classes); strategy-watch is PINNED direct — it depends on Anthropic's
  server-side web_search, which the router does not expose pre-R1** → the split is static
  per-job identity, never a runtime fallback; ANTHROPIC_KILL_SWITCH brakes BOTH paths
  (emergency spend stop regardless of backend); untranslatable content blocks/server tools
  throw rather than silently drop → **S**
- [Q-071] Anthropic "Test connection" always failed (admin UI passes no model → adapter sent
  `model:""` to /v1/messages → guaranteed 400 → provider marked `down`); plus three latent
  request-time 400s on newer Claude models → **(1) empty-model test now hits GET /v1/models
  (auth+reachability check, mirrors openai-compat); openai-compat's /models-404 fallback
  rethrows instead of pinging with an empty model. (2) 4.7+/5-family wire ids
  (ADAPTIVE_ONLY_MODEL regex): thinking budget → `{type:"adaptive"}`, temperature/top_p
  omitted (both removed server-side, 400 if sent). (3) Claude 4.x: temperature preferred over
  top_p, never both (Anthropic rejects the pair on 4+)** → behavior unchanged for the seeded
  4.5/4.6 models; regex must be extended when a new family ships (catalog sync surfaces the
  ids) → **S**

- [Q-072] Scrubber ran only when the PRIMARY model was cloud — a local-default policy with a
  cloud fallback could egress UNSCRUBBED content on a fallback hop (found independently by
  two review passes) → **scrub decision now considers the whole candidate chain: local
  primary + cloud-in-chain prepares a redacted outbound copy swapped in per cloud hop
  (`ctx.cloudEnvelope`); block mode bars cloud hops via routeForModel while local still
  serves; audit events carry `scope: fallback_only`** → local-served requests keep their
  original content (local tier stays exempt); regression suite in resilience.test.ts → **S**
- [Q-073] Multi-firm + accounting hardening batch from the deep review → **(1) budgets_state
  scope_ref keys firm-scoped (`firmId:app` / `firmId:user` — bare app names collided across
  firms: cross-tenant budget DoS + spend leak). (2) Response-cache key now
  firm + model + messages-hash + request-params digest (was model+messages only: cross-firm
  and wrong-shape hits). (3) Streams that die/abort before a usage-bearing finish ledger
  ESTIMATED usage (chars/4, flagged) instead of silent zeros — closes the abort-early budget
  loophole. (4) Admin API firm-scoped everywhere (providers list/patch/delete/test,
  credentials add/promote/revoke, app-tokens list/revoke, dashboard budgets); provider
  delete revokes its credentials; empty PATCH and malformed cookies are 4xx not 500s.
  (5) /healthz probes the DB (2s cache) — the appliance healthcheck chain trusted a
  process-liveness lie. (6) CSV exports neutralize leading formula chars. (7) keyring
  rejects MASTER_KEY_PREVIOUS_VERSION == MASTER_KEY_VERSION. (8) settings accept explicit
  null to clear a key (UI could never unset global_temperature_max)** → known-accepted
  residuals recorded in QA-REPORT Round J → **S/M**
- [Q-074] Suite compat: `txconv_statement_parse` pack default 4096 truncated TxConvertor's
  multi-page extractions (app requests 32k) and app registration re-stamped the low value
  each boot; payroll pack app name `vibe-payroll` didn't match the app's registration
  identity `vibe-payroll-time` (token minted under the pack name → registration 403 loop)
  → **pack default raised to 32768; curated pack defaults now act as a registration FLOOR
  (apps can raise, never lower below pack; operators clamp down via policy
  maxTokensOverride); pack app renamed to the app's real identity** → app-side tickets
  A1–A9 in docs/app-compat-review-2026-08-08.md → **S**
- [Q-075] R4 (operator-directed): route the shared GLM-OCR llama-server through the router →
  **new provider kind `local_ocr` (OpenAI wire shape via the openai-compat adapter — GLM-OCR
  is llama-server on :8090; own kind because routing resolves providers BY KIND and a second
  `local` row would be unreachable next to vibellm, same rationale as Q-060) + the LOCAL
  TIER generalized from `kind === 'local'` to `LOCAL_TIER_KINDS`/`isLocalKind()` across
  local_only sensitivity, scrubber exemption, SSRF LAN-pinning, response-cache tiering, and
  the Q-072 hop-envelope logic. Migration 0004 (reversible; down also strips model ids from
  policy uuid[] arrays — fixing 0003's dangling-reference flaw). UI: provider preset
  `GLM-OCR (local)`, catalog kind option, local-tier policy filter.** Supersedes the
  "OCR stays direct in both modes" portion of Q-068/Q-069 as an OPTION — apps may now route
  OCR page images through the router to a local_ocr provider (image parts pass through
  verbatim; local tier stays scrubber-exempt; property tests updated to the tier
  definition) → **M**
- [Q-077] Exhaustive QA (Round K) connection-handling defects → **(1) total timeout (120s)
  killed every long generation incl. the 32k txconv case: streams now use total-timeout as a
  first-token bound, then the idle timer governs; default raised to 300s; (2) idle watchdog
  armed only after first chunk so Ollama cold-loads aren't killed at 60s; (3) client
  abort / total-timeout no longer recorded as provider failure (was opening the breaker on
  healthy providers → marked down); stream health recorded once not twice; (4) timeouts map
  to provider_unavailable/502 not unknown/500, incl. AbortSignal.timeout on admin/vault
  tests; (5) postSse + SDK flush the decoder and emit a final blank-line-less event (was
  dropping the usage frame → measured billing downgraded to estimated)** → verified against a
  live router with mock upstreams → **M**
- [Q-078] Exhaustive QA (Round K) wire-format defects → **(1) stateful OpenAI stream
  translator: parallel/ omitted-index/split-id tool calls stay distinct + ids synthesized
  (official openai client no longer merges them into garbage); (2) usage-bearing content
  chunk no longer injects a phantom mid-stream finish (vLLM cumulative usage); usage+finish
  in one chunk (DeepSeek) attaches to the real finish; (3) Anthropic tool_result array
  content → block array not JSON.stringify of internals; (4) Anthropic tool_use missing
  input → arguments '{}' not invalid JSON; (5) temperature clamped to Anthropic 0–1;
  (6) cache-write tokens folded into wire prompt_tokens; (7) n>1 rejected at ingress;
  (8) SDK default timeout + signal on every method (registerTaskClasses runs at boot) +
  content-type guard; (9) /version reads package.json (was pinned 0.0.3 for 3 releases)** →
  regression tests added; official-openai-client contract suite + live wire capture confirm
  compliance → **M**- [Q-079] Security test (Round L): can any unauthorized party reach the AI endpoints? →
  **NO — audit + live pen-test confirmed every gateway path (chat/register/billing) requires
  a valid, non-revoked, chat-scoped app token; admin surface requires an admin-role signed
  session + CSRF header; bootstrap requires a timing-safe token; firmId is only ever taken
  from the token/session row, never a client header; cross-firm isolation holds on all
  firm-owned tables. ONE latent gap fixed: task_classes/models are GLOBAL (no firm_id), so a
  firm admin could mutate suite-wide sensitivity/catalog affecting another firm in a
  multi-firm deployment — now guarded (assertSoleFirm → 403 when >1 firm; single-firm
  behavior unchanged), the compliance-critical sensitivity boundary being the key concern**
  → accepted residuals: no login/bearer throttle (Q-052, LAN-only + scrypt cost); client-
  asserted X-Vibe-User-Role is advisory within the trusted-app model; bootstrap /admin/* is
  the intentional global-operator surface (token-gated, unregistered when unset) → **S**
