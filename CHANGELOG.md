# Changelog

Versioning note: the build ran to an internal `1.0.0` (feature-complete, reviewed, QA'd), but
the **first public release is `0.0.1`** — the code has never run against a real appliance, live
model server, or production traffic. The number reflects deployment maturity, not feature
completeness. See "Not yet verified" in the README.

## 0.0.24 — 2026-08-26

**Redundancy for RESULTS, not just for status codes** — a provider that is up and answering
200 with an unusable body is now a hop failure, and a primary that cannot be routed at all no
longer bypasses the fallback chain.

- **Response verification (`src/gateway/verify.ts`).** Adapters already reject structurally
  malformed bodies; nothing judged whether a well-formed envelope carried the answer that was
  asked for. An empty completion, a forced-JSON request answered with prose, tool-call
  arguments that are not JSON, a schema the response does not satisfy — all returned 200, and
  `breaker.record(true)` left the provider green, so nothing retried and no fallback hop was
  ever considered. Each is now a **retryable `invalid_response`**, which buys three layers:
  same-model retry (model output is stochastic — a re-roll often succeeds), then the policy's
  fallback chain, then the breaker if a provider does it persistently. Verification checks
  only what the REQUEST asked for; a plain text completion is checked for emptiness and
  nothing else. `content_filter` refusals are exempt — retrying a refusal only repeats it.
- **Schema checking is a dependency-free JSON Schema SUBSET** (`type` incl. unions/nullable,
  `properties`, `required`, `items`, `enum`, `anyOf`/`oneOf`). Unrecognized keywords never
  fail a response: this is a fault detector, so a construct it cannot evaluate must not
  manufacture a false failure. It is not a gate for untrusted input.
- **Primary routing failures now fall back (`stageRoute`).** `routeForModel` on the primary
  threw straight out of the pipeline, so a deleted provider row, a revoked credential, or a
  base_url the SSRF gate rejects returned an error to the app with the configured chain
  untouched and **zero upstream attempts** — even though the resilient executor re-routes
  every hop and would have handled it. The failure is now deferred to the chain and surfaces
  only if the whole chain is unusable. `savePolicy` never checked provider existence, so this
  was reachable at config time, not only by later drift.
- **Streams can fall back when they produce nothing.** Non-content frames (finish/usage/
  keep-alive) are buffered until the first real content chunk, so a hop that ends without ever
  emitting output has relayed nothing to the consumer and can still be replaced. The no-splice
  rule (10.4) is unchanged — once real content is out, no provider is spliced in behind it.
  Related: the total-timeout wall is now cleared on the first CONTENT chunk rather than the
  first frame, so a provider emitting only keep-alives can no longer hang until the client
  gives up.
- **`max_tokens` is now clamped per MODEL, not just per task class** (operator-directed). The
  class/policy cap describes the WORK; how many tokens a model can actually emit describes the
  MODEL, and the two disagree constantly — `txconv_statement_parse` legitimately asks for
  32768, and a chain falling back to a 4096-output model sent 32768 to it (a hard 400 on
  Anthropic, a silent provider-side cap elsewhere). `models.max_output` was already synced from
  LiteLLM and editable in the catalog; `applyLimits` simply never read it. `clampToModel()` now
  applies it at each hop and NEVER writes back to the shared envelope, because the next hop may
  have a higher ceiling. A null `max_output` means "do not clamp", never "clamp to zero".
  Audited as `max_tokens_clamped` (requested/served counts).
- **Truncation no longer burns retries.** A `finish_reason: length` under a forced-JSON request
  is deterministic — the same model at the same ceiling truncates again — so it leaves the
  same-hop retry loop immediately and advances to a model whose `max_output` can hold the
  answer, instead of spending 1 + MAX_RETRIES attempts proving the point.
- New audit event `response_rejected` (reason + schema PATH only — never the offending value,
  invariant 2), new metric `vibe_router_responses_rejected_total{reason}`, new error code
  `invalid_response` (502, retryable) mirrored in the SDK's `VibeAiError`, and a kill switch
  `ROUTER_VERIFY_RESPONSES` (default `true`) for unblocking traffic while diagnosing an
  over-strict schema.

## 0.0.23 — 2026-08-25

**The admin console works under a path mount** (Q-096) — merges the parked `feat/ui-base-path`.

- The bundle built with Vite's default `base: '/'`, so it requested `/assets/…` no matter where
  it was served from. Under a path prefix those requests hit the **root of the host** — on the
  Vibe Appliance, a different app — returning 200 with HTML, so React never booted and the
  operator got a blank page with nothing in any log. That affected LAN mode and single-host
  domain mode, both defaults. Now `base: './'` plus a mount prefix derived at runtime from
  `document.baseURI`, so one image serves a hostname root and any prefix with no env var,
  build arg, or entrypoint rewriting.
- **Why it sat unmerged for a month**: its CI failed the day it was pushed. `ui/src/api.ts`
  named `document`, and its own test imports that module into the server type program, which
  is deliberately DOM-free. Reading the global through `globalThis` keeps the runtime guard and
  compiles in both programs, without loosening the server's lib.
- **File downloads fixed too**: `audit.csv`, `wisp.docx`, and the new `costs.csv` are plain
  `<a href>`s that never pass through the API wrapper, so they stayed hard-coded absolute and
  would have failed under a path mount even after the merge — the console would look fine until
  someone clicked an export. All three now route through the exported `mounted()`, with a test
  that scans the UI source for raw `href="/admin-api/…"` so the pattern cannot return silently.

## 0.0.22 — 2026-08-25

**Costs view: spend by app, task class, and model** (Q-095).

- New **Costs** page: total spend / requests / tokens for a period (this month, last month,
  last 30 days, all time, or a custom range), then a breakdown by **app**, **task class
  (policy)**, or **model** — click any row to see what it breaks into along the other two
  dimensions (e.g. `vibe-time-billing` → `timebill_file_naming` → `digitalocean/kimi-k2.5`).
- Backed by one grouped ledger query (`GET /admin-api/dashboard/costs`, plus `costs.csv` for
  the same data): the page pivots it client-side, so switching dimension or expanding a row
  costs no round trip. Rows with no task class or no model served appear as `(none)` rather
  than vanishing, so every dimension re-sums to the same firm total.
- **Unpriced requests are surfaced, never folded in**: requests served by a model with no
  catalog pricing are counted per row and called out above the table, since their real cost is
  not in the totals. Sub-cent amounts now render with widening precision instead of `$0.00`.

## 0.0.21 — 2026-08-25

**Policies view: filter by declaring app.**

- The Policies table gains an app filter (default "all apps" with a task-class count). With
  30+ classes across the suite, working on one app meant scanning the whole table; picking an
  app narrows it and shows how many classes that app declared. Client-side filter over the
  existing `/admin-api/policies` payload — no API or enforcement change.

## 0.0.20 — 2026-08-25

**AN-2 review fixes (Q-094): 10-finding code review of 0.0.19, all adopted.**

- **`no_vision_provider` now keys on what is MISSING, not what is required**: a vision-capable
  default that lacks tools correctly fails `capability_missing`; the skip fires only when
  vision itself is unsatisfiable across the default and every configured candidate.
- **Upgrade scan covers the fallback chain**, is deterministic (configured order) and
  local-first; every substitution emits a `capability_upgrade` audit event +
  `vibe_router_capability_upgrades_total` metric — no more silent substitution.
- **Chain exhaustion prefers provider-side errors over policy-side hop skips** (`preferError`):
  a dead vision provider surfaces as retryable 502, not a masking 400.
- **Ledger: distinct `no_vision_provider` request_status** (migration 0006, reversible) so
  by-design vision skips are countable separately from misconfiguration.
- **Precheck resolves through PolicyEngine**: missing/disabled policy → `policy_blocked`
  instead of a false `ok:true`; both billing routes now ride the per-token rate limiter.
- Perf: capability needs computed once per selection; test hygiene: budget mutations in the
  precheck test wrapped in try/finally.

## 0.0.19 — 2026-08-25

**AN-2 gap closure: structured vision skip, capability-upgrade selection, budget precheck (SDK 0.2.2).**

- **New error code `no_vision_provider` (HTTP 409, Q-092)**: emitted when a vision-requiring
  task class (or a request carrying image parts) has no configured provider/model that can
  serve it. Distinct from `capability_missing` so clients (T&B file naming) can treat it as a
  structured skip — file keeps its original name — instead of a failure. Ledger buckets it
  under `capability_missing` (no `request_status` enum migration); audit emits `blocked_policy`.
- **`selectModel` capability upgrade (Q-092)**: a default failing ONLY on capabilities may now
  upgrade to a capability-valid model from the operator-approved allowed set (e.g. a text
  default with a vision model in the allowed set serves image-bearing requests). Policy
  violations (sunset/banned/sensitivity) still never substitute.
- **`POST /v1/budget/precheck` (Q-093)**: app-token authed "can I afford this batch?" reusing
  `checkBudgets`; an exhausted budget returns `{ ok:false, reason:'budget_exceeded' }` at
  HTTP 200 — a precheck reports, never throws. Soft warnings included.
- **SDK 0.2.2**: `no_vision_provider` in `VibeAiErrorCode`, `budgetPrecheck()` wrapper, and
  the `timebill_*` task-class keys (`TIMEBILL_FILE_NAMING` et al.) in `TASK_CLASSES`.

## 0.0.18 — 2026-08-24

**DigitalOcean capability + pricing automation (kimi-k3), catalog workflow, admin account.**

- **kimi-k3 in the curated catalog as the first ENRICH-ONLY entry** (Q-088): DO publishes its
  pricing ($2.85/$14.25 per MTok, cache read $0.285) and capabilities (native vision, prompt
  caching) but not its context window, so the entry carries no `max_input_tokens` and the sync
  now treats such entries as enrich-only — never inserting a row or touching base specs, only
  enriching a discovered row's capabilities and appending pricing. The discovered row stays
  `source='provider'`, so an operator-corrected context window survives every nightly sync.
- **Stale Kimi pricing corrected** to DO's current published rates (k2.5 $0.50/$2.70, k2.6
  $0.95/$4.00; cache-read rates unchanged) plus published max-output figures. Pricing history
  is append-only — historical ledger rows still recompute against the old rates.
- **Live capability probe** (Q-089): "Probe live" in Catalog → Edit sends three synthetic
  requests (1×1 PNG / strict JSON schema / forced tool call) through the model's provider and
  pre-fills the capability checkboxes from what actually worked. Only conclusive outcomes are
  applied; every probe is audited (`model_capabilities_probed`).
- **"Detect from DO docs"** (Q-090): one click scrapes DO's supported-models + pricing docs
  pages (fixed URLs, operator-triggered only) into discovered DO rows — capabilities strictly
  additively, specs only where the discovery placeholder still stands, **pricing captured into
  the append-only history** so discovered models stop billing as `cost_unknown`. Parsers are
  fixture-tested against vendored page snapshots; audited as `catalog_docs_scraped`.
- **Catalog page workflow**: sortable columns (model, kind, context, $/MTok in/out, status),
  capability + source filters, and a **"configured providers only" toggle (default on)** so
  the working view is the models requests can actually route to; unconfigured models carry a
  "no provider" chip. `GET /admin-api/models` now returns `configured` per model.
- **Policy editor honors configured providers**: model pickers offer only models whose
  provider kind the firm has configured; the "why isn't X offered?" list explains the gap
  ("no digitalocean provider configured — add one under Providers"). Presentational only —
  server-side gating is unchanged.
- **Admin account management** (Q-091): Settings → Admin account changes the console login
  email and/or password. The current password is re-verified server-side, all sessions are
  destroyed on success, and the change is audited. Lockout recovery: re-run bootstrap-firm.

## 0.0.17 — 2026-08-23

**`timebill_file_naming` widened to cloud_deidentified — DigitalOcean vision models usable**
(Q-087, operator decision).

- The pack tier moves local_only → cloud_deidentified so DO Gradient's vision + json_schema
  models (`kimi-k2.5`/`kimi-k2.6` — the catalog's only qualifying entries) can be bound
  alongside the local tier. Defaults stay local-first; DO is an explicit allowed/fallback
  choice in the policy editor. Caveat kept on record: the scrubber redacts text parts only,
  so document page images reach a cloud model unscrubbed (same accepted exposure as
  `mybooks_receipt_extract`).
- Pack seeding never widens an existing class: appliances that already registered the class
  local_only widen it in the admin console (audited) — see the Time & Billing runbook.

## 0.0.16 — 2026-08-23

**Time & Billing 0223 compat: `timebill_file_naming` task class** (Q-086).

- Curated-pack entry for the new class TB registers at boot: **local_only**, requires
  vision + json_schema, defaultMaxTokens 300 — identical to what runtime registration
  produces, so seeding is additive and changes no egress behavior. Explainer added to the
  Policies popup; SENSITIVITY-REVIEW.md row added (PENDING review) recording that image
  parts bypass the text scrubber, so widening this class beyond local sends raw document
  page images to the cloud model.
- Time & Billing runbook refreshed: A1 cost recovery + A8 shipped app-side, routing mode is
  now firm-config driven (TB 0222) with the env vars as appliance default, policy table and
  verification steps cover the file-naming class.

## 0.0.15 — 2026-08-11

**Task-class explainers: what each class actually does in its app.**

- The Policies task-class popup now leads with a curated plain-language explanation of the
  workflow behind each of the 31 known task classes (e.g. `mybooks_doc_classify` decides what
  KIND of uploaded document it is and routes it to the right extraction pipeline — it does not
  categorize transactions; that's `mybooks_txn_categorize`). Sourced from the default policy
  pack and the per-app integration runbooks (`ui/src/task-class-explainers.ts`). The app's
  registered one-line description moves to the header as secondary context; unknown/custom
  classes fall back to it as before.

## 0.0.14 — 2026-08-11

**Dependency security patches** (CI audit gate, 14.3).

- pnpm overrides force patched transitive dependencies: `fast-uri` 4.1.2 / 3.1.5
  (GHSA-7p8r-x3mc-p8w7, host confusion via backslash authority introducer — reached via
  fastify/ajv) and `brace-expansion` 5.0.9 (GHSA-rgw5-rvv9-x895, DoS — via @fastify/static).
  `pnpm audit --prod` is clean again; no code changes. The v0.0.13 image shipped before the
  audit gate ran — use this one.

## 0.0.13 — 2026-08-11

**Task-class explainer, connection-triggered catalog refresh, per-model "why hidden" list**
(Q-085).

- **Policies page.** Clicking a task class title opens a popup explaining the class: its
  description and declaring app, what its data boundary means in plain language, which
  capabilities it requires, and its current routing (default model, fallback chain, token cap —
  or the fail-closed "unconfigured" state).
- **Catalog refresh on provider connection.** A successful connection test, a newly stored
  API key, or a manual discover that added models now fires the same background discovery +
  vendored-sync pass the nightly cron runs — so newly served models (DigitalOcean live
  discovery included) and curated-spec enrichment appear without waiting for the cron.
  Additive and idempotent; an in-flight guard collapses bursts; failures never break the
  admin request.
- **Policy editor.** The aggregate "N models hidden" notes are now backed by an expandable
  per-model list naming each active model that is not offered and the exact reason (data tier
  vs missing capability, with the Catalog → capability overrides pointer).

## 0.0.12 — 2026-08-09

**Edit any model from the Catalog** (Q-084).

- New **Edit** action on every Catalog row (`PATCH /admin-api/models/:id`). Capability
  overrides are editable for any model (they win over synced capabilities and survive re-sync);
  display name, context window, max output, and pricing are editable for operator-owned models
  — `custom` and auto-discovered `provider` rows. `synced` (feed-managed) rows accept capability
  overrides only; base-spec edits there are rejected with a clear message, since the next sync
  would overwrite them. Pricing edits append a new `model_pricing` row (history stays
  append-only). The edit invalidates the policy engine (context/capabilities affect gating).
- Directly fixes the discovered-DigitalOcean-model rough edge from 0.0.10/0.0.11: those arrive
  with a placeholder 8192 context window and `cost_unknown` pricing, now correctable in the UI.

## 0.0.11 — 2026-08-09

**DigitalOcean models selectable for JSON policy classes** (follow-up to 0.0.10, Q-083).

- DO models weren't offered when binding a policy for a JSON-extraction task class. Root cause
  was the two config-time gates (data tier + capability), not a bug: DO is a cloud kind (hidden
  for `local_only` classes until the tier is widened), and no DO model advertised `json_schema`
  (curated ones off by design per Q-062; auto-discovered ones had empty capabilities), so DO was
  hidden for every `json_schema` class even after widening.
- **Fix.** Mark `json_schema` capable across DO chat models — the 14 curated
  `data/digitalocean-models.json` entries and the auto-discovery default
  (`DISCOVERED_CAPABILITIES`). `tools`/`vision` stay off (more model-specific; enable per model
  via Catalog capability overrides). Safe because the router re-checks capability at request
  time and DO's API is OpenAI-compatible with broad JSON/structured-output support.
- **UX.** The policy editor now explains *why* models are hidden — "N cloud models hidden
  because this class is local_only; widen the tier" and "N models hidden because they don't
  advertise <cap>; enable in Catalog → overrides" — instead of silently omitting them.
- On an upgraded appliance the curated capability change applies on the next catalog sync
  (nightly, or manual `POST /admin/catalog/sync`); then widen the class tier to cloud.

## 0.0.10 — 2026-08-09

**MyBooks/Time-Billing task-class pack coverage** + **DigitalOcean model auto-discovery**.

- **App AI-task coverage (Q-081).** A call-site audit of myBooks and Vibe-Time-Billing
  confirmed every AI feature maps to a task class the app registers at boot (no hard
  fail-closed gaps), but 8 of those classes — including both support-chat classes
  (`mybooks_chat`, `timebill_support_chat`) — lived only in runtime registration, not the
  curated default pack, so a firm got no pre-provisioned policy and support chat could fail
  closed during the boot-registration window. Added all 8 to `src/policy/pack.ts` as
  **`local_only`** (the safest defensible default, identical to what registration produced —
  zero egress-behavior change). `mybooks_statement_extract` gets the 32768 `defaultMaxTokens`
  floor (matching `txconv_statement_parse`, Q-074) to prevent mid-array truncation.
  `SENSITIVITY-REVIEW.md` updated; four cloud-candidate classes flagged PENDING for a
  deliberate, audited widening.
- **DigitalOcean model auto-discovery (Q-082).** The router now discovers the models a firm's
  DigitalOcean provider actually serves — nightly (alongside catalog sync) and via a new
  on-demand **Discover models** button (`POST /admin-api/providers/:id/discover-models`) — so
  operators no longer hand-edit `data/digitalocean-models.json` and cut a release per model.
  Discovery is additive, conservative, and non-destructive: it queries the provider's live
  `/models` endpoint and inserts only unknown ids as `source='provider'` rows (new enum value,
  reversible migration `0005`) with placeholder context window, no capabilities (operator
  enables via overrides), and no pricing (→ `cost_unknown`). It never deprecates or overwrites;
  the vendored curated feed remains the source of accurate specs and enriches discovered rows
  in place if a curated entry later ships. New `src/catalog/discovery.ts`; audited as
  `provider_models_discovered`.

## 0.0.9 — 2026-08-09

**WISP AI Data-Handling Appendix export** + **SDK `completeJson` truncation check**.

- **WISP export.** New admin-console **Compliance** page and
  `GET /admin-api/wisp.docx` (admin-session, firm-scoped) that generates a Microsoft Word
  *AI Data-Handling Appendix* to the firm's Written Information Security Plan (FTC Safeguards
  Rule 16 CFR 314 / IRS Pub 4557), populated from **live configuration**: data tiers per task
  class, configured providers (local vs cloud), the active scrubber mode + detected
  identifier types, credential encryption, retention, and access controls — scoped as a
  factual exhibit with an attorney-review disclaimer, not a standalone WISP. Re-exporting
  after a provider/tier change reflects it. Adds the pure-JS `docx` dependency (no native
  binaries; offline-safe). New `src/ops/wisp.ts` (`buildWispData` + `renderWispDocx`);
  `MATCH_TYPES` promoted to a runtime const in `src/protect/scrub.ts` as the single source of
  truth the appendix cites.
- **Release build fix.** The SDK `prepare` script (added in 0.2.0 for downstream git-dependency
  installs) ran `tsc` during the router's own Docker build stage, where the SDK source/tsconfig
  aren't copied yet — failing the image build. Latent since 0.2.0 because no release was cut in
  between; it surfaced on the first release since. `prepare` now builds only when its inputs are
  present (downstream install → builds; router Docker install → skips, since the Dockerfile
  builds the SDK explicitly). Validated with a full local Docker build.
- **SDK `completeJson` truncation check** (`@kisaes/vibe-ai-client` 0.2.1). `completeJson`
  now checks `finishReason` **before** parsing and throws a typed
  `VibeAiError('output_truncated')` — carrying the *served* completion-token count — when a
  forced-JSON response is cut off at `max_tokens`. Previously a truncation surfaced as a
  misleading "not valid JSON", or worse, a parseable-but-incomplete prefix returned as
  silent success (dropped data). Low-level `complete()` stays permissive. New `output_truncated`
  code (SDK-synthesized; documented in `docs/integration.md`). Lets the downstream TxConvertor
  copy be retired.

## 0.0.8 — 2026-08-08

**Security test: unauthorized-access audit of the auth surface** (Q-079, QA Round L). A
dedicated auth-bypass code audit plus live penetration testing against a running instance
provisioned with two firms, an admin, a non-admin (staff) user, and rival credentials.

Verdict: no unauthenticated path reaches AI inference, secrets, or an admin session; no
role escalation into admin; app-token scope/revocation enforced; cross-firm isolation holds
on every firm-owned table (providers, credentials, app tokens, policies, settings, audit,
ledger, dashboards). Cookie forgery/tampering, CSRF, and the bootstrap token guard all hold.

One latent finding fixed:
- **Global catalog/sensitivity tables were not firm-scoped.** `task_classes` and `models`
  have no `firmId`, so `PATCH /admin-api/task-classes/:key` (and the model create/override/
  retire routes) mutated suite-wide state. On the supported single-firm appliance a firm
  admin *is* the operator, so this was invisible — but in a multi-firm deployment one firm's
  admin could widen another firm's `local_only` data boundary. These routes now refuse
  (403) when more than one firm exists; single-firm behavior is unchanged. Verified live
  (rival admin's sensitivity change blocked, boundary preserved) with a two-firm regression
  test.

## 0.0.7 — 2026-08-08

**Exhaustive QA round (Round K): connection handling + wire-format correctness** (Q-077
connection, Q-078 format). Two adversarial review passes plus a live black-box harness (real
router + mock OpenAI/Anthropic upstreams, the official `openai` client contract suite, the
SDK end-to-end, 40-way concurrency, and an end-to-end scrubber-redaction check).

Connection (Q-077):
- **Long generations are no longer killed by the total timeout.** The 120s total-timeout
  used to abort *any* stream still producing tokens (a 32k-token local generation needs
  many minutes). Streams now use the total timeout as a time-to-first-token bound only; once
  the first chunk arrives the per-hop idle timeout governs, so a long-but-progressing
  generation runs to completion. Default total raised 120s → 300s; non-streaming large
  completions get the larger budget.
- **The idle watchdog no longer kills cold starts.** It is armed only after the first chunk,
  so an Ollama cold-load (minutes) is bounded by the total timeout, not the 60s idle timer.
- **Client aborts are no longer recorded as provider failures.** A cancelling user (or a
  total-timeout) previously recorded a breaker/health failure, which could open the circuit
  on a healthy provider and mark it `down`. Failures are recorded only when the signal was
  not aborted; stream health is recorded once (relay), not twice.
- Timeouts now map to `provider_unavailable` (502) with a timeout reason instead of a generic
  `unknown`/500 — including `AbortSignal.timeout` on the admin/vault test-connection paths.
- `postSse` flushes the decoder and emits a final event that arrives without a trailing blank
  line (some providers close the socket right after the usage frame) — previously the usage
  frame was dropped and measured billing silently downgraded to estimated. Same fix in the SDK.

Wire format (Q-078):
- **Streamed tool calls survive providers that omit `index` or split id/name across frames**
  (Ollama `/v1`, parallel tool calls). A stateful stream translator keeps calls distinct and
  synthesizes ids, so the official OpenAI client accumulator no longer merges two calls into
  one garbage argument string.
- **A provider that reports cumulative usage on every chunk (vLLM) no longer injects a phantom
  mid-stream `finish`** that truncated the response; usage-bearing content chunks are handled
  correctly, and usage+finish in one chunk (DeepSeek) attaches usage to the real finish.
- **Anthropic tool-result messages with array content** are mapped to text/image blocks
  instead of `JSON.stringify` of the envelope internals (the model was receiving
  `[{"type":"text",...}]` literally).
- **Anthropic `tool_use` with missing input** yields `arguments: "{}"` instead of invalid
  JSON that broke `JSON.parse(tc.function.arguments)`.
- **Temperature is clamped to Anthropic's 0–1 range** (ingress accepts 0–2), so a legal-per-
  OpenAI `1.3` no longer becomes a provider 400.
- **Cache-write tokens are included in wire `prompt_tokens`** (matches LiteLLM's bridge) — a
  first request seeding a large prompt cache no longer under-reports billed input.
- `n > 1` is rejected at ingress instead of silently returning one choice.
- SDK gains a default request timeout and accepts a signal on every method (including
  `registerTaskClasses`, which runs at app boot — a wedged router no longer hangs startup),
  plus a content-type guard so a proxy/login HTML page throws a typed error, not a raw
  `SyntaxError`.
- `/version` now reads package.json at runtime — it had been hard-pinned at 0.0.3 through
  three releases.

## 0.0.6 — 2026-08-08

**R4: GLM-OCR as a routable local-tier provider** (Q-075, operator-directed; supersedes the
"OCR stays direct" portion of Q-068/Q-069 as an option).

- New provider kind `local_ocr` for the shared appliance GLM-OCR llama-server
  (OpenAI-compatible chat completions on `http://vibe-glm-ocr:8090/v1`). Own kind so it can
  coexist with the vibellm `local` provider — routing resolves providers by kind (Q-060
  pattern). Reuses the openai-compat adapter; image content parts (data-URI page scans) pass
  through verbatim.
- The LOCAL TIER is now a set (`LOCAL_TIER_KINDS = local, local_ocr` + `isLocalKind()`):
  `local_only` sensitivity accepts both kinds, both are scrubber-exempt and LAN-pinned by
  SSRF rules, response-cache tiering and the Q-072 per-hop envelope logic treat both as
  on-box. Property-based invariant tests updated to the tier definition.
- Migration `0004_local_ocr_kind` (reversible; the down also strips removed model ids from
  policy `allowed_model_ids`/`fallback_chain` arrays — fixing the dangling-reference flaw
  0003's down had).
- Console: "GLM-OCR (local)" provider preset, `local_ocr` custom-model kind option, policy
  editor offers local_ocr models to `local_only` classes.

## 0.0.5 — 2026-08-08

**Deep review + suite compatibility hardening** (Q-072/Q-073/Q-074, QA Round J; app-side
findings in `docs/app-compat-review-2026-08-08.md`).

- **Fallback-scrub gap closed (Q-072).** The scrubber decided cloud-bound-ness from the
  primary model only; a local-default policy with a cloud fallback could egress unscrubbed
  content on a fallback hop. The scrub decision now spans the whole candidate chain: with a
  local primary, cloud hops receive a redacted outbound copy (local hops keep the original),
  and in block mode cloud hops are barred while local still serves.
- **Tenant isolation (Q-073):** budget state keys firm-scoped (two firms running the same
  app shared one budget row — cross-tenant DoS + spend leakage); response-cache key now
  includes firm and a request-params digest; admin API firm-scoped across providers,
  credentials, app tokens, and dashboards; provider delete revokes its credentials.
- **Accounting integrity (Q-073):** streams that die or are aborted before the final usage
  chunk now ledger estimated usage (flagged) instead of silent zeros — closes the
  abort-early budget-evasion loophole.
- **Ops (Q-073):** `/healthz` probes Postgres (2s cache, 503 when down) instead of lying;
  CSV exports neutralize formula injection; keyring rejects a previous-key version equal to
  the current; firm settings accept explicit `null` to clear a key (the console could never
  unset the global temperature cap); malformed cookies and empty provider PATCHes are 4xx.
- **Console: task-class tier is now editable** (Policies → class editor → tier selector,
  backed by the existing audited `PATCH /admin-api/task-classes/:key`). The API lever
  existed since Phase 11 but the UI only displayed the tier — operators had no console path
  to widen a conservative-default `local_only` class toward cloud providers.
- **Suite compat (Q-074):** `txconv_statement_parse` default output raised to 32768 (4096
  truncated TxConvertor multi-page extractions) and curated pack defaults now floor app
  registration; `payroll_anomaly_review` pack app renamed to `vibe-payroll-time` to match
  the app's registration identity (mismatch made registration 403 forever).

## 0.0.4 — 2026-08-08

**Anthropic connectivity fixes** (Q-071, QA Round I) — operator-reported "cannot connect to
Anthropic" traced to the credential test path, plus three latent request-shape 400s.

- `AnthropicAdapter.testConnection` with no model (the admin "Test connection" button and the
  setup wizard pass none) previously sent `model:""` to `/v1/messages` — a guaranteed 400
  that marked the provider `down` regardless of key validity. It now validates auth and
  reachability via `GET /v1/models`, matching the openai-compat family; an explicit model
  still runs the 1-token ping.
- Claude 4.7+/5-family models (`ADAPTIVE_ONLY_MODEL`): thinking budget now maps to
  `{type:"adaptive"}` and `temperature`/`top_p` are omitted — Anthropic removed all three
  fields there (400 if sent). Behavior unchanged for 4.6-and-earlier models.
- Claude 4.x rejects `temperature` and `top_p` together — the adapter now prefers
  `temperature` and drops `top_p` on Anthropic requests.
- openai-compat `/models`-404 test fallback no longer pings with an empty model; it surfaces
  the original `/models` failure (DigitalOcean-relevant only if DO drops `GET /v1/models`).

## 0.0.3 — 2026-07-29

**DigitalOcean Gradient serverless inference as a provider** (Q-060/061/062) — access to
70+ hosted open-source models (Llama, DeepSeek, Qwen, Mistral, GPT-OSS, Kimi) through the
firm's own DO account and model access key.

- New provider kind `digitalocean` reusing the OpenAI-compat adapter. Its own kind — not an
  `openai_compat` preset — because routing resolves the firm's provider *by kind*; a second
  openai_compat row would be unreachable next to OpenAI/Groq. Migration `0003` (reversible).
- Admin UI preset "DigitalOcean (Gradient)" → `https://inference.do-ai.run/v1`, Bearer
  model-access-key credential, standard test-connection flow.
- Curated catalog `data/digitalocean-models.json`: 14 open-source models with DO's published
  per-MTok pricing, merged into the vendored feed (LiteLLM's snapshot carries no DO entries).
  The platform's commercial Anthropic/OpenAI models are deliberately not listed — those route
  through their own provider kinds with the firm's own keys.
- Conservative capability flags: DO documents tool calling only for its commercial models, so
  `tools`/`json_schema` default false and config-time gating refuses task classes that require
  them (fail closed); operators unlock per model via capability overrides after verifying.
- All boundary machinery applies unchanged, now covered by tests against a mock DO server:
  scrubber redacts before egress, `local_only` can never route there (config AND request
  time), SSRF https+public-host gates, ledger rows priced from the curated feed.

## 0.0.2 — 2026-07-27

Hardening from the appliance integration review (defects found by the operator reviewing the
role split — QA-REPORT.md Round H):

- **`/metrics` is now gateway-role only.** A `console` container gets the public vhost, and it
  was carrying the unauthenticated Prometheus endpoint (per-task-class request counts, provider
  names, breaker state). The appliance also blocks `/metrics` at the edge (`deny_paths`); this
  removes the surface from the container itself.
- **Background data work is role-gated to the gateway** (catalog sync scheduler, hourly
  credential auto-revoke, daily ledger retention purge). In a split deployment both containers
  share one database, and every job ran twice; the appliance's `CATALOG_SYNC_CRON=""` workaround
  on the console is no longer required.
- Clean-room script: `/metrics` asserted on the gateway and asserted *absent* on a split
  console; new role-separation checks.

## 0.0.1 — 2026-07-27

First public release. Contains everything below (internal phases 0–15 plus seven post-review QA
rounds), with the Phase 15 review outcomes applied:

- Scrubber firm default changed **block → redact** (Q-056): protected numbers become `[TYPE]`
  tokens before cloud transmission; block remains a per-firm setting. Invariant suite updated
  (block-mode invariant now sets the mode explicitly).
- Runtime standardized on **Node 24** (Q-057): image base, engines, CI.
- All sensitivity-tier assignments confirmed as built (SENSITIVITY-REVIEW.md marked reviewed).
- TB call-site migration (MIG-1) deferred by decision to its own ticket (Q-058) — this release
  ships the router only; trial-balance-app swaps in the MIG-1 window.

Post-review hardening (QA rounds A–G, 16 defects found and fixed — see QA-REPORT.md): phantom
billing on cache hits, SQL/parameter disclosure via the default error handler, a login timing
oracle, an unbounded session store, a nightly catalog sync that aborted mid-run on the real
feed, cloud-hosted models misclassified as local, and the `ROUTER_ROLE` split that lets the
admin console have TLS without publishing the app-facing gateway alongside it.

### Build history (pre-public, internal versions)

One autonomous build pass over phases 0–14 of `VIBE-AI-ROUTER-BUILD-PLAN.md`:

- Gateway: OpenAI-compatible `/v1/chat/completions` with `X-Vibe-Task-Class` (fail closed),
  SSE streaming, frozen internal envelope + error taxonomy.
- Adapters: openai-compat (OpenAI/Azure/Ollama/Groq/DeepSeek quirks) + Anthropic native
  (prompt caching, extended thinking, forced-tool json_schema).
- Policy engine: per-task-class sensitivity tiers, dual-time capability gating, role gating,
  firm overrides, default local-first policy pack, export/import.
- Data protection: deterministic scrubber (SSN/EIN/ABA/account/Luhn) on all cloud egress,
  block/redact/warn; append-only audit (DB-enforced); CI invariant suite.
- Vault: AES-256-GCM envelope encryption, write-only API, staged rotation, master-key rotation.
- Ledger & budgets: one row per request, append-only pricing history, cache savings,
  firm/app/user/task-class budgets, billing feed, recompute script.
- Resilience: retries, breakers, per-hop-revalidated fallbacks, rate limits, load shed,
  timeouts; chaos suite.
- Admin: session-authed API + React console (wizard, policy editor, dashboards, audit, tokens);
  Playwright smoke in CI.
- SDK `@kisaes/vibe-ai-client` 0.1.0 + integration contract + migration playbook + shadow-diff
  harness.
- Ops: Prometheus metrics, opt-in response cache, hardened image (GHCR), appliance/Vault docs,
  graceful shutdown, retention controls.
- Security: STRIDE-lite threat model, SSRF base-url gates (config + request time), dependency
  audit gate + SBOM, load test (50 rps: p95 added latency 19.6 ms < 25 ms budget).

Known deferrals (tracked in QUESTIONS.md / PHASES.md): live-vibellm smoke on first appliance
deploy (Q-011); Vibe TB call-site swap staged for the Phase 15 window (Q-047); 1-hour memory
soak on appliance hardware.
