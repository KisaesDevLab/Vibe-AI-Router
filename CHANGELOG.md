# Changelog

Versioning note: the build ran to an internal `1.0.0` (feature-complete, reviewed, QA'd), but
the **first public release is `0.0.1`** — the code has never run against a real appliance, live
model server, or production traffic. The number reflects deployment maturity, not feature
completeness. See "Not yet verified" in the README.

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
