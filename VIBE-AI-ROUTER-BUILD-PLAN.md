# Vibe AI Router — Master Build Plan

**Product:** Vibe AI Router (working repo name: `Vibe-AI-Router`, org: KisaesDevLab)
**Role in suite:** Sole AI egress point for all Vibe apps. Firms configure their own provider API keys; router enforces task-class policy, data protection, and cost accounting. Replaces the scrapped Vibe Shield concept with routing-layer enforcement + local-first defaults.
**Stack:** Node.js 20, TypeScript (strict), Fastify (chosen over Express for first-class SSE streaming and lower proxy overhead), Drizzle ORM, PostgreSQL 16, Redis 7 (optional; rate limiting + response cache), React 18 + Vite admin UI, Docker single-container + shared appliance Postgres.
**License:** BSL 1.1 (Apache 2.0 at 4-year conversion), consistent with Vibe Trial Balance. Confirm in Phase 0.
**Build conventions:** CLAUDE.md / PHASES.md / STATE.md / QUESTIONS.md autonomous build. Conventional commits. Bash(*) permissions assumed.

---

## Governing Principles (encode into CLAUDE.md)

1. **Apps never hold provider keys.** All AI traffic from every Vibe app goes through the router. No exceptions, no "temporary" direct calls.
2. **Local-first.** The appliance is fully functional with only the local tier (Ollama/vibellm). Cloud providers are opt-in per firm. Zero-cloud mode must never regress.
3. **Fail closed on data protection.** Scrubber errors, policy-lookup failures, or unknown task classes block cloud egress; they never fall through to "allow."
4. **Prompt bodies are never persisted.** Logs, ledger, and audit records store metadata and hashes only. This is a hard invariant tested in CI.
5. **Policy is enforced server-side.** The admin UI is a convenience; the router validates every request against policy independently of what the UI allowed to be configured.
6. **Capability gating happens at config time AND request time.** A model that can't do tool calling can't be saved to a tool-calling task class, and a request requiring tools to a non-tool model is rejected with a clear error, not silently degraded.
7. **Deterministic cost.** Every completed request produces exactly one ledger row with computed cost. If pricing is unknown for a model, cost is flagged `estimated=false, unknown=true` — never silently zero.
8. **One internal message format.** Adapters translate at the edge. Core logic (policy, scrubbing, ledger, fallbacks) operates only on the internal envelope and never sees provider-specific shapes.

---

## Repo Layout (target)

```
/src
  /server            Fastify bootstrap, plugins, auth
  /gateway           request pipeline, envelope, streaming
  /adapters          openai-compat/, anthropic/, base adapter contract
  /catalog           model catalog service, pricing sync
  /policy            task classes, policy engine, capability gating
  /vault             credential storage, encryption, connection tests
  /protect           scrubber, audit logger
  /ledger            cost computation, budgets
  /resilience        retries, circuit breakers, fallbacks, rate limits
  /admin-api         REST endpoints for UI
/ui                  React admin UI (Vite)
/packages/sdk        @kisaes/vibe-ai-client — thin client for Vibe apps
/db                  Drizzle schema, migrations, seeds
/test                unit, integration, contract, invariant suites
/docs                integration contract, ops runbook, firm-facing guide
/scripts             pricing sync, seed, smoke tests
```

---

## Cross-Cutting Process Rules (apply to every phase)

- **Fully autonomous execution:** No human review between phases. The build runs Phase 0 → 14 without stopping. All ambiguity is resolved by the Decision Protocol below; the human reviews once, at the end, in Phase 15.
- **Decision Protocol (replaces gates):** When a decision point arises: (1) choose the safest defensible default — prefer local-first, fail-closed, restrictive-over-permissive; (2) implement it; (3) log it in QUESTIONS.md as `[Q-nnn] question → default chosen → rationale → refactor cost if reversed (S/M/L)`. Never stall, never ask mid-build. Decisions with refactor cost L must additionally be isolated behind a config flag or interface so reversal in Phase 15 is cheap.
- **Definition of Done per phase:** all checklist items checked; unit tests for new logic; integration test for the phase's happy path + one failure path; STATE.md updated; no `any` types introduced; migration is reversible.
- **Contract-first:** Any interface consumed by another phase (adapter contract, envelope, SDK) is written and frozen as a `.d.ts` + doc in the phase that introduces it. Later phases may extend, not break.
- **Invariant test suite** (`/test/invariants`) runs in CI on every commit from Phase 8 onward: (a) no prompt body in any DB table or log output, (b) `local_only` task class cannot reach a cloud adapter, (c) scrubber match on cloud-bound request returns 4xx, (d) every 2xx completion writes exactly one ledger row.
- **Seed data:** Phase 1 creates a seed script with one demo firm, local provider, three task classes, and fixture models so every subsequent phase is manually testable immediately.
- **QUESTIONS.md protocol:** append-only decision log per the Decision Protocol above. Grouped by phase, each entry tagged with refactor cost. This file becomes the Phase 15 review agenda — keep entries answerable in one sentence each.

---

## Phase 0 — Scaffolding & Decisions

- [ ] 0.1 Init repo, TypeScript strict config, ESLint/Prettier, Vitest, tsx dev runner
- [ ] 0.2 Fastify skeleton with health endpoint `/healthz`, version endpoint `/version`
- [ ] 0.3 Docker: multi-stage Dockerfile, compose file with Postgres 16 + Redis 7 for dev
- [ ] 0.4 Drizzle + migration tooling wired; empty initial migration runs clean
- [ ] 0.5 CLAUDE.md written: principles above, stack, conventions, invariants
- [ ] 0.6 PHASES.md (this plan) and STATE.md committed
- [ ] 0.7 CI: typecheck, lint, test, build on push (GitHub Actions)
- [ ] 0.8 DECISIONS.md: record license (BSL 1.1?), Fastify choice, port (default 8220 — block 8220–8229 reserved in the suite port table; original 8300 collided with Vibe-1099's dev `mock-tax1099`), service name for Caddy/Tunnel
- [ ] 0.9 Env config module with zod validation; refuse to boot on invalid config; document every env var
- [ ] 0.10 Structured logger (pino) with redaction paths pre-configured (`req.body.messages`, `res.body.choices`) — redaction exists before any AI traffic exists

**Acceptance:** container boots, `/healthz` green, CI green, DECISIONS.md complete with rationale for each choice (reviewed in Phase 15).

---

## Phase 1 — Data Model

Full schema up front so later phases don't fight migrations. All tables have `created_at/updated_at`, soft-delete where noted.

- [ ] 1.1 `firms` (id, name, slug, settings jsonb) — single-firm appliance still uses this table; multi-tenant-ready
- [ ] 1.2 `users` (id, firm_id, role: admin|partner|staff, external_ref for SSO-later)
- [ ] 1.3 `providers` (id, firm_id, kind: openai_compat|anthropic|local, label, base_url, auth_type, status, last_health_at, health jsonb) — soft delete
- [ ] 1.4 `provider_credentials` (id, provider_id, ciphertext, key_version, last4, created_by, rotated_from nullable) — never a plaintext column
- [ ] 1.5 `models` catalog (id, canonical_id e.g. `anthropic/claude-sonnet-4.5`, provider_kind, display_name, context_window, max_output, capabilities jsonb {tools, json_schema, vision, caching, reasoning}, status: active|deprecated|sunset, deprecation_date, source: synced|custom)
- [ ] 1.6 `model_pricing` (model_id, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, currency) — append-only history for accurate historical ledger recompute
- [ ] 1.7 `task_classes` (id, key e.g. `tb_classification`, app, description, sensitivity: local_only|cloud_deidentified|cloud_allowed, requires jsonb {tools?, json_schema?, vision?}, default_max_tokens, registered_by_app_version)
- [ ] 1.8 `policies` (id, firm_id, task_class_id, default_model_id, allowed_model_ids[], fallback_chain[], max_tokens_override, temperature_min/max, monthly_budget_cents nullable, enabled)
- [ ] 1.9 `role_policies` (policy_id, role, allowed: bool) — staff/partner gating
- [ ] 1.10 `usage_ledger` (id, ts, firm_id, user_id, app, task_class_id, model_requested, model_served, provider_id, prompt_tokens, completion_tokens, cached_read_tokens, cache_write_tokens, cost_cents numeric(12,6), cost_unknown bool, latency_ms, status, engagement_ref nullable, client_ref nullable, request_hash)
- [ ] 1.11 `audit_log` (id, ts, firm_id, user_id, app, task_class, event: request|blocked_scrubber|blocked_policy|provider_error|config_change, model, provider, detail jsonb — schema-validated to guarantee no body content, request_hash)
- [ ] 1.12 `budgets_state` (scope: firm|app|user, scope_ref, period yyyymm, spent_cents, soft_notified_at, hard_stopped_at) — denormalized fast-path for budget checks
- [ ] 1.13 `app_tokens` (id, firm_id, app, token_hash, scopes[], last_used_at) — how Vibe apps authenticate to the router
- [ ] 1.14 Indexes: ledger (firm_id, ts), (task_class_id, ts), (client_ref, ts); audit (firm_id, ts); budgets unique (scope, scope_ref, period)
- [ ] 1.15 Seed script: demo firm, admin user, local Ollama provider, 3 task classes, 5 fixture models with pricing, one policy each
- [ ] 1.16 Migration reversibility test in CI (up → down → up)

**Acceptance:** `pnpm seed` produces a fully navigable dataset; schema doc generated into /docs.

---

## Phase 2 — Gateway Core & Internal Envelope

- [ ] 2.1 Define `AIRequest` internal envelope: {taskClass, messages[], tools?, responseFormat?, maxTokens?, temperature?, stream, metadata {app, userId, engagementRef?, clientRef?}} — frozen contract doc `/docs/envelope.md`
- [ ] 2.2 Define `AIResponse` envelope: normalized message/toolCalls/finishReason + `usage` {promptTokens, completionTokens, cachedReadTokens, cacheWriteTokens} + `served` {model, providerId, latencyMs}
- [ ] 2.3 Normalized error taxonomy: `auth_error`, `rate_limited`, `provider_unavailable`, `context_exceeded`, `content_filtered`, `policy_blocked`, `scrubber_blocked`, `capability_missing`, `budget_exceeded`, `unknown` — with HTTP status mapping and machine-readable `code` field
- [ ] 2.4 POST `/v1/chat/completions` accepting OpenAI-compatible body PLUS required header `X-Vibe-Task-Class` and optional `X-Vibe-Engagement` / `X-Vibe-Client` — reject requests missing task class (fail closed)
- [ ] 2.5 App-token auth (bearer), per-token scopes, constant-time hash compare
- [ ] 2.6 Request pipeline as explicit ordered middleware: auth → resolve task class → policy → scrub → route → adapt → ledger → respond. Each stage pure-function testable
- [ ] 2.7 SSE streaming plumbing: pass-through chunk relay with heartbeat, client-disconnect abort propagated to upstream, usage captured from final chunk
- [ ] 2.8 Request ID + hash (SHA-256 of canonicalized messages) generated once, threaded through all logs/ledger/audit
- [ ] 2.9 Body size limits, JSON depth limits, message-count sanity caps
- [ ] 2.10 Contract tests: OpenAI-SDK-as-client against the router (point official `openai` npm client at it) for non-streaming and streaming

**Acceptance:** router accepts requests and returns a stubbed adapter response end-to-end, streaming and non-streaming, with correct error taxonomy.

---

## Phase 3 — Adapter Framework + OpenAI-Compatible Adapter

- [ ] 3.1 `ProviderAdapter` contract: `capabilities()`, `translateRequest(env)`, `execute(req, signal)`, `translateResponse(raw)`, `translateStreamChunk(raw)`, `testConnection(cred)` — frozen doc `/docs/adapter-contract.md`
- [ ] 3.2 OpenAI-compat adapter: chat completions, tools, response_format json_schema, vision content parts, streaming
- [ ] 3.3 Base-URL variants tested against: OpenAI, Azure OpenAI (api-version query + deployment path quirk), Ollama (`/v1` compat), Groq, DeepSeek — record quirks table in docs
- [ ] 3.4 Azure quirk handling: deployment-name-as-model mapping stored on provider record
- [ ] 3.5 Ollama/local: capability probe on connection test (does the served model support tools? detect via /api/show), context length discovery
- [ ] 3.6 Usage extraction incl. `stream_options.include_usage` for streaming where supported; token fallback estimation flagged when provider omits usage
- [ ] 3.7 Finish-reason normalization table with tests per variant
- [ ] 3.8 Error mapping: provider HTTP/error-body → normalized taxonomy, with raw detail preserved in audit (bodies stripped)
- [ ] 3.9 Adapter integration test harness with recorded fixtures (no live keys in CI) + optional live smoke script for local dev
- [ ] 3.10 Route stubbed pipeline to real local Ollama — first true end-to-end completion via vibellm

**Acceptance:** a real prompt flows app-token → router → vibellm Qwen3 → normalized response; Azure fixture tests pass.

---

## Phase 4 — Anthropic Native Adapter

- [ ] 4.1 Messages API translation: system prompt extraction, content blocks, tool_use/tool_result mapping to internal toolCalls
- [ ] 4.2 Prompt caching: automatic `cache_control` breakpoint insertion strategy (system + tools + leading context), configurable per task class; cache read/write token capture into usage
- [ ] 4.3 Extended thinking support: passthrough of thinking budget when task class enables it; thinking blocks excluded from persisted anything, surfaced in response envelope optionally
- [ ] 4.4 Streaming event translation (message_start/delta/stop, content_block events) → internal chunk format
- [ ] 4.5 max_tokens required-field handling (Anthropic mandates it) — inject task-class default
- [ ] 4.6 Error mapping incl. overloaded_error → `provider_unavailable` (retryable)
- [ ] 4.7 Fixture-based tests for tool calling round trip and cache token accounting
- [ ] 4.8 Comparative test: same envelope through OpenAI-compat and Anthropic adapters yields structurally identical `AIResponse`

**Acceptance:** identical internal envelope produces correct native calls on both adapter families; cache tokens appear in usage.

---

## Phase 5 — Model Catalog & Pricing Sync

- [ ] 5.1 Catalog service: CRUD for custom models, read API for UI and policy engine
- [ ] 5.2 Vendored sync from LiteLLM `model_prices_and_context_window.json` (pinned URL + checksum): map to internal schema, filter to supported provider kinds
- [ ] 5.3 Sync is additive + flagging: never auto-delete; mark missing models `deprecated`, surface diff report
- [ ] 5.4 Pricing writes append to `model_pricing` history with `effective_from = sync date`
- [ ] 5.5 Capability inference from sync data (supports_function_calling, supports_vision, etc.) with manual override field that survives re-sync
- [ ] 5.6 Cron (node-cron in-process) nightly sync + manual trigger endpoint; sync failures alert but never block serving
- [ ] 5.7 Deprecation alert job: any policy referencing deprecated/sunset model → audit event + UI banner
- [ ] 5.8 Custom model entry validation (context window, pricing optional → cost_unknown ledger flag)
- [ ] 5.9 Unit tests: sync idempotency, override survival, diff report accuracy

**Acceptance:** catalog populated from sync; a custom local model coexists; re-running sync changes nothing unexpectedly.

---

## Phase 6 — Credential Vault

- [ ] 6.1 Envelope encryption: per-appliance master key (env/file mount) wrapping per-credential data keys, AES-256-GCM; key_version on every row
- [ ] 6.2 Write-only API: keys accepted, encrypted, last4 stored; no read-back endpoint exists at the HTTP layer
- [ ] 6.3 Master key rotation script: re-wrap all credentials, bump versions, documented in ops runbook
- [ ] 6.4 Credential rotation flow: add new credential → test → promote → old enters grace window → auto-revoke
- [ ] 6.5 `testConnection` per adapter wired to "Test" action: live minimal call (1-token completion or models list), result + latency stored on provider record
- [ ] 6.6 Provider health monitor: passive (rolling error rate from live traffic) + optional active probe interval; status: healthy|degraded|down
- [ ] 6.7 Startup check: decrypt-ability of all active credentials; fail loudly on key mismatch
- [ ] 6.8 Invariant test: grep-level + runtime assertion that no plaintext credential ever appears in logs, error messages, or API responses

**Acceptance:** full add→test→rotate→revoke lifecycle via API; master rotation script verified on seed data.

---

## Phase 7 — Task-Class Policy Engine

- [ ] 7.1 App registration endpoint: apps declare their task classes + requirements on startup (idempotent upsert); version-stamped
- [ ] 7.2 Policy resolution: (firm, task class) → effective policy {model, fallbacks, limits} with caching (invalidate on config change)
- [ ] 7.3 Config-time capability gating: saving a policy validates every allowed/fallback model against task-class `requires` — reject with specific missing capability
- [ ] 7.4 Request-time enforcement (defense in depth): re-validate capability + sensitivity + role before routing; unknown task class → reject
- [ ] 7.5 Sensitivity enforcement: `local_only` → route must resolve to provider kind `local`; assertion tested in invariant suite
- [ ] 7.6 Firm global overrides: banned provider kinds, banned model patterns, global max temperature
- [ ] 7.7 Role gating: role_policies checked against authenticated user context passed by app
- [ ] 7.8 max_tokens injection: request value clamped to policy override or task-class default; never unset on cloud calls
- [ ] 7.9 Policy export/import JSON with schema validation (deployment templates for new firms)
- [ ] 7.10 Default policy pack: sensible local-first defaults for every known Vibe task class, applied on firm creation
- [ ] 7.11 Property-based tests: random policy/config combinations never produce a cloud route for local_only, never select a model lacking required capabilities

**Acceptance:** default policy pack + sensitivity assignments complete for all Vibe apps, with a dedicated `SENSITIVITY-REVIEW.md` table (app / task class / sensitivity / rationale) generated for Phase 15 — this is the single most compliance-critical review item and is flagged FIRST on the Phase 15 agenda. Until reviewed, every assignment defaults to the most restrictive plausible tier (when in doubt: local_only).

---

## Phase 8 — Data Protection (Scrubber + Audit)

- [ ] 8.1 Deterministic scrubber module: SSN (with area-number validation), EIN (prefix table), US bank routing (ABA checksum), account-number heuristics (co-occurring with routing), credit card (Luhn) — pure functions, exhaustive unit tests incl. lookalike negatives (dates, invoice numbers, ZIP+4)
- [ ] 8.2 Scrubber runs only on cloud-bound requests (local tier exempt), over all message text content incl. tool results
- [ ] 8.3 Per-firm mode: block (default) | redact (`[SSN]` token substitution) | warn — mode stored on firm settings; block returns `scrubber_blocked` with match types only (never matched values)
- [ ] 8.4 Redact mode round-trip safety: redaction applied to outbound copy only; original envelope untouched in memory; no de-tokenization (one-way)
- [ ] 8.5 Audit logger: every pipeline decision point emits typed audit event; jsonb detail validated against per-event zod schema that structurally cannot contain message content
- [ ] 8.6 Config-change auditing: all admin-API mutations (policy, provider, credential meta) logged with actor + before/after (credentials: metadata only)
- [ ] 8.7 Audit query API: filterable by date/app/event/user; CSV export
- [ ] 8.8 Invariant suite activated in CI (see cross-cutting rules) — this phase turns it on
- [ ] 8.9 Performance budget: scrubber < 5ms on 100KB payload (benchmark test)

**Acceptance:** invariant suite green; scrubber test corpus (true/false positives) documented in /docs.

---

## Phase 9 — Cost Ledger & Budgets

- [ ] 9.1 Cost computation: usage tokens × effective pricing (pricing row where effective_from ≤ request ts, latest) incl. cache read/write rates; numeric(12,6) cents precision
- [ ] 9.2 Ledger write in pipeline finally-block: exactly one row per completed OR failed request (failed rows: status + zero/partial usage) — idempotency by request ID
- [ ] 9.3 Streaming: usage from final chunk; if upstream omits, estimate via tokenizer (js-tiktoken for OpenAI-compat, char heuristic fallback) with `cost_unknown` handling per principle 7
- [ ] 9.4 Budget engine: budgets_state fast-path check pre-request (soft: attach warning header + audit; hard: reject `budget_exceeded`); atomic spend increment post-request; monthly rollover job
- [ ] 9.5 Budget scopes: firm total, per app, per user — all optional, most restrictive wins
- [ ] 9.6 Cache savings computation: (cached tokens × (input − cache_read rate)) surfaced as savings metric
- [ ] 9.7 Aggregation queries for dashboards: spend by day/model/app/task-class/client, p50/p95 latency — as SQL views or prepared queries
- [ ] 9.8 CSV export endpoints (ledger, aggregates)
- [ ] 9.9 T&B billing feed (deferred integration, build the surface): read-only endpoint `/v1/billing/usage?client_ref=&period=` returning cost-recovery line items — documented for Vibe T&B addendum
- [ ] 9.10 Ledger recompute script: replay cost from token counts against pricing history (for pricing corrections)
- [ ] 9.11 Concurrency test: 100 parallel requests produce exactly 100 ledger rows and correct budget totals

**Acceptance:** spend visible per dimension on seed traffic; hard budget stop verified under concurrency.

---

## Phase 10 — Resilience: Fallbacks, Retries, Circuit Breakers, Rate Limits

- [ ] 10.1 Retry policy: retryable taxonomy codes only (rate_limited, provider_unavailable), exponential backoff + jitter, max 2 retries, respect Retry-After
- [ ] 10.2 Per-provider circuit breaker: open on rolling error-rate threshold, half-open probes, state surfaced to health dashboard; breaker state in Redis when present, in-memory fallback
- [ ] 10.3 Fallback chains: on non-retryable provider failure or open breaker, advance through policy fallback_chain; each hop re-passes capability + sensitivity checks (a fallback can't downgrade to a non-compliant model); hops recorded in audit
- [ ] 10.4 Streaming fallback rule: fallback only before first content chunk sent to client; after first chunk, fail the stream cleanly with error event
- [ ] 10.5 Timeouts: connect/headers/total budgets per provider kind, streaming idle timeout, all configurable
- [ ] 10.6 Rate limiting: token-bucket per app-token and per user (Redis-backed, in-memory fallback), 429 with Retry-After
- [ ] 10.7 Load-shed guard: max concurrent upstream requests per provider; queue with cap, then reject
- [ ] 10.8 Chaos tests: fault-injecting mock provider (5xx, timeouts, malformed chunks, mid-stream death) driving the full pipeline; assert fallback/breaker/ledger behavior
- [ ] 10.9 Abort propagation test: client disconnect cancels upstream within 1s (no orphaned token burn)

**Acceptance:** chaos suite green; a dead primary provider transparently serves via fallback with correct audit trail.

---

## Phase 11 — Admin API + Admin UI

Read /mnt/skills frontend-design guidance at build time; match Vibe suite visual conventions.

- [ ] 11.1 Admin REST API: providers, credentials (write-only), catalog, task classes, policies, budgets, audit, dashboards — role-guarded (admin), zod-validated, all mutations audited
- [ ] 11.2 UI shell: auth, nav, firm context; React 18 + Vite, consistent with MyBooks component patterns
- [ ] 11.3 Provider setup wizard: pick kind → base URL (presets for OpenAI/Azure/Anthropic/Ollama) → paste key → live test with latency result → save; Azure deployment-mapping step
- [ ] 11.4 Model catalog browser: search/filter, capability chips, $/1M tok display, deprecation badges; add-custom-model form
- [ ] 11.5 Policy editor: per task class — default model picker (filtered to capability-valid models only), allowed list, drag-order fallback chain, limits; inline validation errors from config-time gating; sensitivity shown as read-only badge with explainer
- [ ] 11.6 Global firm settings: scrubber mode, banned providers, budgets
- [ ] 11.7 Dashboards: spend over time, by app/model/task class; budget gauges with soft/hard markers; cache savings; provider health tiles (latency, error rate, breaker state)
- [ ] 11.8 Live request log view (metadata only): stream of recent audit events with filters
- [ ] 11.9 Empty states + zero-cloud mode messaging ("Running fully local — add a cloud provider to enable…")
- [ ] 11.10 UI e2e smoke (Playwright): wizard → policy edit → send test prompt → see ledger row

**Acceptance:** a non-technical firm admin can go from blank appliance to working cloud provider + policy without docs.

---

## Phase 12 — App Integration SDK & First App Migration

- [ ] 12.1 `@kisaes/vibe-ai-client` package: typed client over the router (complete(), stream(), task-class constants, engagement/client ref plumbing, error taxonomy types); zero provider SDKs inside
- [ ] 12.2 Task-class registration helper: app declares classes at boot via SDK
- [ ] 12.3 Integration contract doc `/docs/integration.md`: auth, headers, envelope, errors, streaming, versioning policy — the frozen contract for all 12+ apps
- [ ] 12.4 Migrate first app: **Vibe Trial Balance** AI classification path to the SDK (highest volume, local-tier, lowest risk)
- [ ] 12.5 Shadow validation: run old direct path and router path side-by-side on fixture data; diff outputs; retire direct path
- [ ] 12.6 Migration playbook doc distilled from 12.4 for remaining apps (per-app checklist template: enumerate call sites → map to task classes → register → swap → verify ledger)
- [ ] 12.7 App token issuance flow in appliance provisioning (each app gets scoped token at install)
- [ ] 12.8 Backward-compat stance recorded: envelope/SDK semver rules, deprecation window

**Acceptance:** TB migration shadow-diff report generated (match rate, divergence samples with hashes not bodies) and attached to Phase 15 agenda; direct path retained behind a feature flag until Phase 15 sign-off, then removed.

---

## Phase 13 — Ops, Metrics, Caching, Packaging

- [ ] 13.1 Prometheus metrics endpoint: request counts/latency by task class+provider, breaker states, budget rejections, scrubber blocks, sync age
- [ ] 13.2 Optional response cache: opt-in per task class (extraction-type idempotent calls), key = request hash + model, Redis TTL, local-tier only by default; hit metrics
- [ ] 13.3 Production Docker image hardening: non-root, healthcheck, read-only fs where possible; publish to GHCR per suite convention
- [ ] 13.4 Vibe Appliance integration: compose service definition, Caddy route, Cockpit/Portainer visibility, port + env documented in Appliance plan addendum
- [ ] 13.5 Vibe Vault integration: backup set = Postgres tables (config, catalog, ledger, audit) + encrypted credential rows + master-key EXCLUDED with documented separate-custody procedure; restore test added to Vault quarterly checklist
- [ ] 13.6 Ops runbook: master key rotation, provider outage triage, budget override, sync failure, restore procedure
- [ ] 13.7 Log rotation/retention config; audit + ledger retention policy setting (default: retain indefinitely, metadata only)
- [ ] 13.8 Graceful shutdown: drain in-flight streams, flush ledger writes

**Acceptance:** router runs inside the full appliance compose stack behind Caddy; backup/restore verified.

---

## Phase 14 — Security Review, Load Test, Pre-Release Hardening

- [ ] 14.1 Threat-model pass (STRIDE-lite) documented: app-token theft, credential exfil, SSRF via custom base_url (mitigate: URL allowlist/deny private ranges toggle for cloud kinds; local kind pinned to LAN config), admin-API authz, log injection
- [ ] 14.2 SSRF mitigation implemented per 14.1
- [ ] 14.3 Dependency audit + lockfile policy; SBOM generated
- [ ] 14.4 Load test: sustained 50 rps mixed streaming/non-streaming against mock provider; memory stability over 1h; p95 overhead < 25ms added latency (excl. upstream)
- [ ] 14.5 Full invariant + chaos + e2e suites green in CI
- [ ] 14.6 Firm-facing docs: setup guide, "where your data goes" one-pager (local vs cloud per task class), FAQ for peer-review/insurer questions
- [ ] 14.7 §7216 / engagement-letter language template updated: names firm's own chosen provider(s), no intermediary — hand to attorney
- [ ] 14.8 CHANGELOG, license files, README complete; version tagging deferred to 15.12
- [ ] 14.9 Draft per-app migration tickets (per Phase 12.6 playbook) ready to schedule after Phase 15 sign-off

**Acceptance:** all suites green, docs complete, release candidate tagged `1.0.0-rc.1`. Production deployment and `1.0.0` tag happen only after Phase 15.

---

## Phase 15 — Human Review, Q&A, Refinement (the ONLY human touchpoint)

The build agent prepares everything below, then conducts a structured Q&A with Kurt and executes refinements. Nothing ships to production before this phase completes.

**15A — Review packet generation (agent, before Q&A)**
- [ ] 15.1 `REVIEW-PACKET.md` assembled: one-page architecture summary, DECISIONS.md, full QUESTIONS.md decision log grouped by refactor cost (L first), SENSITIVITY-REVIEW.md, TB shadow-diff report, threat-model doc, load-test results, screenshot walkthrough of admin UI flows
- [ ] 15.2 Q&A agenda ordered by consequence: (1) sensitivity assignments per task class, (2) refactor-cost-L decisions, (3) default policy pack models/limits, (4) scrubber mode default, (5) budget defaults, (6) naming/branding/port, (7) everything else batched
- [ ] 15.3 Each agenda item phrased as a closed question with the implemented default stated ("Currently X — keep or change to Y?") so review is fast; target: reviewable in one sitting
- [ ] 15.4 Demo environment: seeded appliance running locally with scripted walkthrough (wizard → policy → live request → dashboard) so answers can be given against working software, not descriptions

**15B — Q&A session (Kurt)**
- [ ] 15.5 Walk agenda; record answers inline in REVIEW-PACKET.md as `KEEP` / `CHANGE: <instruction>`
- [ ] 15.6 Any new requirements surfaced are triaged: refinement (this phase) vs backlog (post-1.0)

**15C — Refinement execution (agent)**
- [ ] 15.7 Implement every CHANGE with tests; re-run full invariant + chaos + e2e suites
- [ ] 15.8 Remove TB direct-path feature flag; delete dead code
- [ ] 15.9 Update all contract docs and firm-facing docs to reflect changes
- [ ] 15.10 Second shadow-diff run on TB if classification-affecting changes were made
- [ ] 15.11 Final gap-prevention checklist pass (below)
- [ ] 15.12 Tag `1.0.0`, deploy to own firm, schedule remaining app migrations per playbook

**Acceptance:** Kurt's answers all resolved as KEEP or implemented CHANGE; suites green; 1.0.0 live at own firm.

---

## Deferred Backlog (tracked, not planned)

- Bedrock adapter (SigV4), Vertex adapter (GCP auth)
- OpenRouter as an optional provider entry (fits openai_compat adapter + provider-prefs passthrough)
- Embeddings + rerank endpoints (Tax Research Chat dependency — promote when that build starts)
- Semantic caching; A/B shadow routing for model evaluation
- Multi-appliance fleet telemetry (opt-in) into licensing portal
- SSO for admin UI (piggyback suite-wide auth decision)

---

## Dependency Graph (build order rationale)

```
0 → 1 → 2 → 3 → 4
         2 → 5 (catalog needs envelope-adjacent types only)
    1 → 6 (vault)
3,4,5,6 → 7 (policy needs adapters+catalog+creds)
7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15
```

Phases 5 and 6 can run parallel to 3/4 if desired; everything downstream of 7 is strictly serial because each layer's invariants build on the last. Phase 15 is the sole human touchpoint.

## Gap-Prevention Checklist (agent verifies at end of every phase; final pass in 15.11)

- [ ] Zero-cloud mode still fully functional (automated smoke)
- [ ] Invariant suite green (from Phase 8)
- [ ] No new env var undocumented
- [ ] No contract doc drift (envelope/adapter/integration docs match code)
- [ ] QUESTIONS.md entries complete with defaults + refactor cost tags
- [ ] STATE.md reflects reality
