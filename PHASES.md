# PHASES.md — per-item build status

Mirrors `VIBE-AI-ROUTER-BUILD-PLAN.md` (source of truth for full item text). `[x]` done,
`[~]` partial (note why), `[ ]` open. Acceptance line per phase when met.

## Phase 0 — Scaffolding & Decisions

- [x] 0.1 Repo init, TS strict, ESLint/Prettier, Vitest, tsx
- [x] 0.2 Fastify skeleton /healthz + /version
- [x] 0.3 Docker multi-stage + dev compose (pg16, redis7)
- [x] 0.4 Migration tooling wired; 0000_init runs clean
- [x] 0.5 CLAUDE.md
- [x] 0.6 PHASES.md + STATE.md
- [x] 0.7 CI (typecheck, lint, test, build, docker, up-down-up)
- [x] 0.8 DECISIONS.md (D-001..D-007: license, Fastify, port 8220, service name)
- [x] 0.9 Zod env config, refuse-to-boot, docs/env.md
- [x] 0.10 Pino with redaction paths pre-configured

## Phase 1 — Data Model

- [x] 1.1 firms
- [x] 1.2 users (+ email/display_name for Phase 11 auth — see STATE 2026-07-26)
- [x] 1.3 providers (soft delete, health jsonb, model_mapping for Azure)
- [x] 1.4 provider_credentials (no plaintext column; rotation fields ready for Phase 6)
- [x] 1.5 models (+ capability_overrides ready for Phase 5.5)
- [x] 1.6 model_pricing (append-only history)
- [x] 1.7 task_classes
- [x] 1.8 policies (unique firm+task_class)
- [x] 1.9 role_policies
- [x] 1.10 usage_ledger (request_id unique = idempotency; cost numeric(12,6))
- [x] 1.11 audit_log (append-only enforced by trigger; event as text per Q-005)
- [x] 1.12 budgets_state (unique scope/scope_ref/period)
- [x] 1.13 app_tokens
- [x] 1.14 indexes
- [x] 1.15 seed script (demo firm, admin, local provider, 3 classes × 3 tiers, 5 models, policies, app token)
- [x] 1.16 reversibility up→down→up in CI + lingering-table assertion

**Acceptance met:** `pnpm seed` navigable + idempotent (test-verified); schema doc at docs/schema.md.

## Phase 2 — Gateway Core & Envelope

- [x] 2.1 AIRequest envelope + docs/envelope.md (frozen)
- [x] 2.2 AIResponse envelope
- [x] 2.3 Error taxonomy + HTTP mapping (+ invalid_request extension, Q-008)
- [x] 2.4 POST /v1/chat/completions with required X-Vibe-Task-Class (fail closed)
- [x] 2.5 App-token bearer auth, scopes, constant-time compare
- [x] 2.6 Ordered pipeline auth→class→policy→scrub→route→adapt→ledger→respond (scrub/ledger stubs)
- [x] 2.7 SSE relay: heartbeat, client-disconnect abort (response-close detection), usage from final chunk
- [x] 2.8 Request ID + canonical SHA-256 hash threading
- [x] 2.9 Body/messages/JSON-depth caps (env-tunable)
- [x] 2.10 Contract tests with official `openai` client, streaming + non-streaming

**Acceptance met:** stubbed adapter end-to-end both modes; taxonomy verified (401/403/400 paths);
abort propagation <1s test.

## Phase 3 — Adapter Framework + OpenAI-Compatible Adapter

- [x] 3.1 ProviderAdapter contract frozen (src/adapters/contract.ts + docs/adapter-contract.md)
- [x] 3.2 openai-compat adapter: tools, json_schema, vision, streaming
- [x] 3.3 Flavor variants OpenAI/Azure/Ollama/Groq/DeepSeek + quirks table in docs
- [x] 3.4 Azure deployment-as-model via provider.model_mapping
- [x] 3.5 Ollama capability probe (/api/show) + context-length discovery
- [x] 3.6 Usage extraction incl. stream_options.include_usage; estimated-usage fallback flagged
- [x] 3.7 Finish-reason normalization table, tested per variant
- [x] 3.8 Error mapping → taxonomy, truncated provider body preserved for audit
- [x] 3.9 Fixture harness (pure translate fns + in-process mock server); live smoke script
- [~] 3.10 Real-Ollama end-to-end: mock-verified; live run deferred to appliance deploy
        (no Ollama on dev box — scripts/smoke-live.ts is the verification vehicle)

**Acceptance:** met except live-vibellm leg of 3.10 (see STATE); Azure fixtures green.

## Phase 4 — Anthropic Native Adapter

- [x] 4.1 Messages translation: system extraction, content blocks, tool_use/tool_result, images
- [x] 4.2 Prompt caching: automatic breakpoints (system+tools+leading context), per-task-class flag, cache tokens in usage
- [x] 4.3 Extended thinking: budget passthrough, thinking surfaced on AIResponse only (never persisted)
- [x] 4.4 Streaming event state machine → internal chunks
- [x] 4.5 max_tokens injection (policy) + 4096 last-resort in adapter
- [x] 4.6 Error mapping incl. overloaded_error → provider_unavailable
- [x] 4.7 Fixtures: tool round trip + cache token accounting
- [x] 4.8 Comparative test: identical envelope → structurally identical AIResponse across families

**Acceptance met:** both adapter families verified against one dual-dialect mock; cache tokens
appear in usage; json_schema handled via forced-tool mapping (Q-014).

## Phase 5 — Model Catalog & Pricing Sync

- [x] 5.1 Catalog service: custom CRUD, retire (sunset when referenced), read helpers
- [x] 5.2 Vendored LiteLLM sync (data/litellm-prices.json, 291 chat models, sha256 in data/VENDOR.md)
- [x] 5.3 Additive+flagging: vanish→deprecated, reappear→reactivate, never delete; diff report
- [x] 5.4 Pricing appends to history (effective_from = sync date), only on change
- [x] 5.5 Capability inference + capability_overrides survive re-sync and win
- [x] 5.6 node-cron nightly (CATALOG_SYNC_CRON) + POST /admin/catalog/sync (bootstrap token);
        failures audit+log, never block serving
- [x] 5.7 Deprecation alert job → model_deprecation_warning audit events
- [x] 5.8 Custom model validation; pricing optional → cost_unknown path
- [x] 5.9 Tests: idempotency, override survival, diff accuracy, history append, reactivation

**Acceptance met:** vendored feed populates catalog; custom models coexist untouched; re-sync
is a no-op (test-proven, incl. jsonb key-order pitfall).

## Phase 6 — Credential Vault

- [x] 6.1 Envelope encryption: master key wraps per-credential DEK, AES-256-GCM, key_version keyring
- [x] 6.2 Write-only API: add/list(meta)/promote/revoke/test — no read-back path exists
- [x] 6.3 Master rotation script (scripts/rotate-master-key.ts) + runbook procedure
- [x] 6.4 Rotation flow add→test→promote→timed grace→hourly auto-revoke
- [x] 6.5 testConnection wired; result/latency/probe stored on provider row
- [x] 6.6 Health monitor: passive rolling window (50), healthy/degraded/down at 20%/50%,
        ordered persists + audit on transition; active probe deferred to Phase 13 metrics loop
- [x] 6.7 Startup decryptability check; refuses boot on key mismatch
- [x] 6.8 No-plaintext invariant: ciphertext/list/audit/provider-health serialization asserts

**Acceptance met:** full lifecycle via API test-verified incl. rewrap on live rows; local-only
mode (no MASTER_KEY) keeps serving keyless providers.

## Phase 7 — Task-Class Policy Engine

- [x] 7.1 Registration endpoint: idempotent, version-stamped; new classes forced local_only;
        registration can never change existing sensitivity
- [x] 7.2 PolicyEngine resolution cache (30s TTL) + invalidate on every config mutation
- [x] 7.3 Config-time gating in savePolicy — rejects with the specific missing capability
- [x] 7.4 Request-time re-validation (modelViolation) incl. request-derived requirements
- [x] 7.5 local_only → local kind, enforced at select AND per fallback hop (routeForModel)
- [x] 7.6 Firm overrides: banned kinds, banned model patterns (wildcards), global temp max
- [x] 7.7 Role gating (explicit deny wins; absent rule allows)
- [x] 7.8 max_tokens inject + clamp; never unset (Anthropic requires it anyway)
- [x] 7.9 Export/import JSON with zod validation; import never widens sensitivity
- [x] 7.10 Default policy pack (14 classes, 8 apps) local-first; capability-orphans left
        unresolved = fail closed
- [x] 7.11 Property tests (fast-check, 700 runs): no cloud route for local_only, no
        capability-lacking selection — rejection always counts as safe

**Acceptance met:** default pack + SENSITIVITY-REVIEW.md generated (Phase 15 item #1).

## Phase 8 — Data Protection (Scrubber + Audit)

- [x] 8.1 Deterministic scrubber: SSN/EIN/ABA/account-heuristic/Luhn+IIN, exhaustive corpus incl. lookalike negatives
- [x] 8.2 Cloud-bound only (selected model kind ≠ local); all text incl. tool args + results
- [x] 8.3 Modes block(default)/redact/warn from firm settings; block reveals types+counts only
- [x] 8.4 Redact = outbound deep copy; original object untouched; one-way
- [x] 8.5 Pipeline decision events with zod-validated detail (request/blocked_*/scrubber_*/provider_error)
- [x] 8.6 Config-change audit on policy saves (credentials already audited in Phase 6)
- [x] 8.7 Audit query API + CSV export (/admin/audit, /admin/audit.csv)
- [x] 8.8 Invariant suite live in CI: (a) no-body-anywhere scan of every table + logs,
        (b) tampered-policy local_only escape blocked, (c) 422 + counts-only, (d) exactly-one
        ledger write (interface level; Phase 9 adds row level)
- [x] 8.9 Perf: <5ms median on 100KB, test-enforced

**Acceptance met:** invariant suite green; corpus documented in docs/scrubber.md.

## Phase 9 — Cost Ledger & Budgets

- [x] 9.1 Cost from effective pricing history; disjoint usage semantics normalized in adapters;
        cache rates with conservative input-rate fallback
- [x] 9.2 DbLedger: one row per authed request (success or failure), on-conflict-do-nothing on
        request_id; budget increments only on first write
- [x] 9.3 Streaming usage from final chunk (Phase 2 relay); estimated usage → cost_estimated
- [x] 9.4 Budget engine: pre-request fast path, soft header X-Vibe-Budget-Warning + audit,
        hard 402, atomic upsert increments
- [x] 9.5 Scopes firm/app/user (+ per-task-class via policy.monthly_budget_cents SUM); most
        restrictive wins
- [x] 9.6 Cache savings computed alongside cost
- [x] 9.7 spendBy(day/model/app/task_class/client) + p50/p95 latency
- [x] 9.8 /admin/ledger.csv + /admin/ledger/aggregate
- [x] 9.9 /v1/billing/usage?period=&client_ref= (app-token authed)
- [x] 9.10 scripts/recompute-ledger.ts (--dry supported)
- [x] 9.11 100-parallel concurrency test: 100 rows, unique ids, budget total = Σ batch costs

**Acceptance met:** spend visible per dimension; hard stop verified; pre-auth failures are
log-only by design (Q-033).

## Phase 10 — Resilience

- [x] 10.1 Retries: retryable codes only, exp backoff + jitter, max 2, Retry-After honored/capped
- [x] 10.2 Per-provider breaker: rolling 30s window, open ≥50% @ ≥10 samples, half-open single
        probe, transitions audited; in-memory (single-container correct; Redis seam Q-038)
- [x] 10.3 Fallback chains: advance on provider failure/open breaker; EVERY hop re-passes
        capability+sensitivity via routeForModel; hops audited (fallback_hop)
- [x] 10.4 Streaming fallback only pre-first-chunk (generator primed in stageAdapt so pre-chunk
        failures are real HTTP errors); post-chunk death → clean error event, no splice
- [x] 10.5 Total timeout + streaming idle watchdog (env-tunable); composite abort signals
- [x] 10.6 Token buckets per app-token + per user, 429 + Retry-After, 0-disables
- [x] 10.7 Load-shed: per-provider semaphore + bounded queue → shed as 429/retry-after 1
- [x] 10.8 Chaos suite: 5xx, 429-retry, malformed chunks, mid-stream death, hang; asserts
        fallback serve (model = fallback), breaker short-circuit (0 upstream hits), ledger rows
- [x] 10.9 Abort ≤1s (Phase 2 test still green under resilient path)

**Acceptance met:** dead primary transparently serves via fallback with audit trail; chaos green.

## Phase 11 — Admin API + Admin UI

- [ ] 11.1 … 11.10

## Phase 12 — App Integration SDK & First App Migration

- [ ] 12.1 … 12.8

## Phase 13 — Ops, Metrics, Caching, Packaging

- [ ] 13.1 … 13.8

## Phase 14 — Security Review, Load Test, Hardening

- [ ] 14.1 … 14.9

## Phase 15 — Human Review

- [ ] 15.1 … 15.12
