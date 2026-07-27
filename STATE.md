# STATE.md — build verification journal

Newest first. Updated after every meaningful change (suite build-kit convention).

## 2026-07-27 — Post-1.0.0 QA rounds A/B/C (apps on hold per Q-059)

- Round A regression: 216/216, e2e green, load PASS (+18.0ms p95), audit clean.
- Round B adversarial: new permanent fuzz suite (test/qa-round-b.test.ts, ~6.5k cases/run) +
  manual sweep → **5 defects found & fixed with regressions**: streaming budget-warning header
  dropped by writeHead-after-hijack; cache-hit ledger rows billed phantom tokens/cost (High);
  shed-slot leak when client aborts a primed stream; task-class budget SUM not firm-scoped;
  billing period boundary double-count. Details: QA-REPORT.md.
- Round C clean-room: image rebuilt with fixes, booted on an EMPTY database (migrations at
  boot), seeded, black-box scripts/qa-clean-room.ts 22/22 — kept as the standing appliance
  acceptance script.
- Migration tickets marked ON HOLD (Q-059). Rig torn down (qa db dropped, mock stopped).

## 2026-07-27 — Phase 15B+15C complete → v1.0.0

- 15B: Kurt answered the full agenda in interactive Q&A (verdict table at the top of
  REVIEW-PACKET.md). All KEEP except: scrubber default → redact (Q-056), Node 24 (Q-057),
  TB swap deferred to MIG-1 ticket (Q-058).
- 15C applied: pipeline default ?? 'redact' (both read sites), seed firm redact, invariant (c)
  hardened to set block explicitly, (c3) restores redact; Dockerfile node:24-alpine,
  engines >=24, CI node 24; docs synced (scrubber.md, firm docs, SENSITIVITY-REVIEW marked
  reviewed-KEEP, CLAUDE.md current-state, DECISIONS D-005, CHANGELOG 1.0.0).
- 15.10: no second shadow-diff — no classification-affecting change (scrubber default affects
  cloud-bound only; TB classification is local_only).
- Re-verified: typecheck/lint clean, 206/206, e2e smoke green, Node 24 image built + smoked
  (healthz/version 1.0.0/UI/metrics).
- Tagged v1.0.0. Remaining operator actions: appliance deploy (docs/appliance.md), first-deploy
  verifications (Q-011/Q-054), schedule MIG-1…8 (docs/migration-tickets.md).

## 2026-07-26 — Phase 15A complete — BUILD PAUSED FOR HUMAN REVIEW

- REVIEW-PACKET.md assembled: 7 consequence-ordered agenda items (sensitivity first), all
  closed KEEP/CHANGE questions, demo walkthrough, screenshot set (docs/screenshots/01–08,
  captured via Playwright against the seeded stack).
- Final gap-prevention pass: SSRF env var + budget stage + disjoint-usage semantics were doc
  drift — fixed in env.md/envelope.md. Zero-cloud smoke, invariant suite, QUESTIONS/STATE all
  current.
- Autonomous run ends here by design (Decision Protocol §Phase 15). Next actor: Kurt, with
  REVIEW-PACKET.md. 15C executes the answers, lands MIG-1 (TB swap), tags 1.0.0.

## 2026-07-26 — Phase 14 complete → v1.0.0-rc.1

- Threat model docs/threat-model.md (T1–T6 + accepted residuals).
- SSRF (14.2): lib/ssrf.ts host classification; cloud kinds https+public (DNS-checked at
  config time via admin API, pattern-checked per request behind SSRF_DENY_PRIVATE_CLOUD);
  local kind rejects public hosts. Tests updated (loopback mocks set the toggle off).
- Deps: drizzle-orm 0.45.2 (high advisory fixed), pnpm audit clean + gated in CI; SBOM step
  in release workflow.
- Load test (scripts/load-test.ts): 50 rps × 60s mixed, 0 errors, ADDED p95 19.6ms < 25ms.
  Required hot-path work: engine-level firm/provider caches (10s TTL, invalidated on config
  change), task-class resolve folded into engine (one query less), ledger pricing cache (60s).
  First naive harness burst-fired and read 604ms — documented in Q-053.
- Firm docs (docs/firm/): setup guide, where-your-data-goes, FAQ, §7216 draft. README,
  CHANGELOG, migration tickets (8). Version 1.0.0-rc.1.
- Verified: 206/206 + e2e; image smoke earlier.

## 2026-07-26 — Phase 13 complete

- Metrics (src/ops/metrics.ts, prom-client): request totals/duration by class+provider+status,
  scrubber/budget/rate-limit/fallback counters, cache events, breaker gauges refreshed at
  scrape, catalog sync age; /metrics endpoint (internal-network only, Q-051). Terminal
  recording piggybacks emitTerminalAudit so every path is covered.
- Response cache (src/ops/cache.ts): task-class opt-in (requires.cache_ttl_s), hash+model key,
  local-tier default (cache_cloud to widen), LRU+TTL, deep-copy isolation; cache hits still
  write ledger rows (Q-049). Test proves 1 adapter call for 2 identical requests.
- Packaging: image now ships server+SDK+UI+migrations+vendored data, runs migrations on start,
  stateless (read-only fs OK). packageManager pinned (corepack pulled pnpm 11 needing Node 22 —
  build broke; pinned 9.15.9). GHCR release workflow on v* tags.
- docs/appliance.md (compose/Caddy/manifest/provisioning/Vault set/Prometheus) + runbook
  completed (outage triage, budget override, sync failure, restore) + retention (13.7:
  LEDGER_RETENTION_DAYS job; audit immutable Q-050).
- Graceful shutdown: drain + 15s force + health flush.
- Verified: 186/186; production image built + smoke pending note below.

## 2026-07-26 — Phase 12 complete (12.4 staged per Q-047)

- SDK (packages/sdk, @kisaes/vibe-ai-client 0.1.0): dependency-free typed client — complete(),
  stream() (SSE parser incl. error events), registerTaskClasses(), billingUsage(), VibeAiError
  with taxonomy + retryable, TASK_CLASSES constants. Builds to dist with .d.ts.
- Contract docs frozen: integration.md (auth/registration/errors/env/versioning),
  migration-playbook.md (8 steps + TB status).
- Shadow harness: scripts/shadow-diff.ts + data/shadow-fixtures.json (20 TB classification
  cases); dual-path run, normalized-JSON compare, hash-only SHADOW-DIFF-REPORT.md
  (gitignored — the real one is generated on the appliance).
- Verified: 183/183 incl. SDK end-to-end through real router + real adapter against mock
  provider, ledger attribution of SDK dims, and harness spawn test (100% match).
- TB repo swap deliberately NOT performed here (Q-047) — staged for Phase 15 window.

## 2026-07-26 — Phase 11 complete

- Admin API (/admin-api): scrypt login + signed sessions (migration 0002 adds
  users.password_hash; seed sets demo password), full CRUD surface per PHASES 11.1, CSRF
  double-guard, every mutation audited. Test-prompt endpoint drives the real pipeline and
  ledgers as app 'admin-ui' (Q-046).
- UI (/ui, React 18 + Vite, no UI libs): ledger visual identity (bankbook green + monospace
  display), signature data-boundary chips LOCAL/SCRUBBED/CLOUD everywhere a class appears,
  zero-cloud lamp in the topbar. Pages: Dashboard (spend bars/latency/budget gauge/health +
  breaker tiles + test prompt), Providers (wizard w/ Azure mapping, credential lifecycle),
  Catalog, Policies (capability-filtered pickers, ordered fallbacks, inline gate errors),
  Tokens (mint-once display), Audit (live poll), Settings.
- Static serving: router serves ui/dist with SPA fallback (tsx vs dist path pitfall fixed).
- Playwright smoke GREEN locally (login→wizard→policy→test prompt→audit evidence) and wired
  into CI (chromium install step). Backend: 177/177.
- Fix found by e2e: test-prompt path forgot emitTerminalAudit — audit page showed nothing.

## 2026-07-26 — Phase 10 complete

- Resilience primitives (src/resilience/): backoff (jitter, Retry-After), CircuitBreaker
  (rolling window, half-open single probe, success-can't-open rule Q-040, snapshot() for
  dashboards), RateLimiter (token bucket, 0-disables), LoadShedGuard (semaphore + bounded
  queue).
- Executor: per-hop routeForModel re-validation, breaker gating, shed, retries, total timeout,
  stream idle watchdog; streaming fallback strictly pre-first-chunk. KEY FIX: stream generator
  is primed in stageAdapt so pre-chunk failures return real HTTP codes instead of 200+error
  event (chaos-test-caught).
- Rate limiting in stageAuth (per token, per user), audited.
- Chaos suite green: 429-retry counts hits, 500-primary→local-fallback serves with correct
  ledger attribution, malformed chunks tolerated, mid-stream death yields clean terminal error
  without provider splice, hang bounded by total timeout with exactly one ledger row, open
  breaker short-circuits with zero upstream hits.
- Verified: 175/175.

## 2026-07-26 — Phase 9 complete

- Cost engine (ledger/cost.ts): $/MTok → cents(6dp); unknown pricing → cost_unknown never 0;
  cache savings; missing cache rates fall back to input rate. Usage semantics normalized
  DISJOINT across adapters (Q-034) — OpenAI wire shapes re-add cached on the way out.
- DbLedger: one row per authed request incl. failures (status mapping), idempotent on
  request_id, budget increment gated on first insert. Pre-auth failures: no row (Q-033).
- Budgets: firm/app/user via budgets_state fast path (atomic upsert += ), per-task-class via
  indexed SUM; soft warnings → X-Vibe-Budget-Warning header + audit; hard → 402.
- Aggregates: spendBy 5 dimensions, p50/p95; /admin/ledger.csv + aggregate endpoint; billing
  feed /v1/billing/usage grouped by client/engagement/app/class; recompute script.
- Verified: 162/162 incl. 100-parallel concurrency (100 rows, unique ids, budget == Σ costs).

## 2026-07-26 — Phase 8 complete

- Scrubber (src/protect/scrub.ts): SSN (area/group/serial validation, keyword-gated bare
  9-digit), EIN (79-prefix table), ABA (checksum + FR prefix ranges), account co-occurrence
  heuristic, card (Luhn+IIN incl. MC 2-series). Overlap precedence card→routing→ssn→ein→acct.
  Perf: median <5ms on 100KB (test-enforced).
- stageScrub: cloud-bound detection via the same pure selectModel as routing; block/redact/warn
  from firm settings; scrubber errors → scrubber_blocked (fail closed); redact = outbound deep
  copy only.
- Audit: pipeline decision events with per-event zod detail schemas; terminal emission from
  runPipeline + SSE relay; savePolicy config_change; query API + CSV export on bootstrap admin.
- Invariant suite (test/invariants.test.ts) LIVE: whole-database marker scan + log scan,
  tampered-policy cloud-escape test, 422 counts-only, exactly-one-ledger-write counting.
- Verified: 152/152.

## 2026-07-26 — Phase 7 complete

- PolicyEngine (src/policy/engine.ts): cached resolution, modelViolation (sunset/sensitivity/
  banned/capabilities incl. request-derived needs), selectModel (advisory honored only when
  allowed+valid; failing default errors — never degrades), applyLimits (temp clamps both ways,
  max_tokens inject+clamp), checkRole.
- Pipeline rewired: stagePolicy → engine.resolve + role + limits; stageRoute → selectModel +
  routeForModel (exported per-hop for Phase 10 fallbacks — a fallback cannot dodge checks).
  ExecuteContext now carries promptCaching/thinkingBudget from task-class requires.
- savePolicy config-time gate; export/import with never-widen-sensitivity rule; registration
  endpoint with forced-local_only for unknown classes; default pack (14 classes/8 apps) +
  SENSITIVITY-REVIEW.md flagged as Phase 15 item #1.
- Verified: 130/130 incl. fast-check property invariants (700 runs) and endpoint tests.
  Test-fixture lesson: fakeModel ignored its overrides — silent false-greens; fixed.

## 2026-07-26 — Phase 6 complete

- Vault: AES-256-GCM envelope crypto with versioned keyring (crypto.ts), lifecycle service
  (add→test→promote→grace→auto-revoke), write-only bootstrap admin endpoints, startup
  decryptability check wired into boot, master rotation script + runbook.
- Pipeline: stageRoute resolves decrypted keys via injected getApiKey; api_key providers with
  no credential → provider_unavailable. stageAdapt + SSE relay feed the passive HealthMonitor
  (client aborts excluded from provider blame).
- Health monitor: 50-outcome window, ordered persist chain per provider (race caught by test:
  parallel persists landed degraded after down), transition audits.
- Local-only mode: MASTER_KEY unset → warn + serve keyless providers; credential endpoints 503.
- Verified: 108/108. No-plaintext assertions across ciphertext blob, listings, audit rows,
  provider.health JSON.

## 2026-07-26 — Phase 5 complete

- Vendored LiteLLM feed (291 chat models across openai/azure/anthropic/groq/deepseek/ollama;
  sha256 + provenance in data/VENDOR.md). parseFeed maps provider→kind, prefixes canonical ids,
  converts $/tok → $/MTok; skips non-chat and context-less entries with names reported.
- syncCatalog: additive+flagging (deprecate on vanish, reactivate on return, custom rows
  untouched), pricing history append only on change, capability_overrides never written.
  Pitfall fixed: Postgres jsonb reorders keys — capability comparison must be key-order
  insensitive or every sync reports spurious updates.
- Catalog service: custom CRUD (zod, pricing optional → cost_unknown), retire→sunset when
  policy-referenced, pricingAt(ts), findRetiredModelReferences.
- Jobs: node-cron nightly + deprecation alerts; failures audit (catalog_sync_failed) and never
  block. Bootstrap admin surface behind ADMIN_BOOTSTRAP_TOKEN (Q-018).
- Minimal audit writer with per-event zod detail schemas (Q-019); registry extensible for
  Phase 8.
- Verified: 96/96 twice consecutively (state-pollution guard: resetDb in exact-count suites).

## 2026-07-26 — Phase 4 complete

- Anthropic native adapter: Messages API translation (system extraction, tool_use/tool_result
  round trip, base64/url images), forced-tool json_schema mapping (Q-014), 3-breakpoint
  ephemeral caching behind ExecuteContext.promptCaching, thinking budget passthrough with
  transient-only surfacing, streaming state machine (block-index→tool-index, usage folding from
  message_start/message_delta), full error-type mapping incl. 529 overloaded.
- Registry now serves all three kinds; envelope gained optional AIResponse.thinking.
- Verified: 87/87 tests; comparative 4.8 test proves envelope-level structural identity
  between adapter families against a dual-dialect mock server.

## 2026-07-26 — Phase 3 complete (3.10 live leg deferred)

- ProviderAdapter contract frozen; openai-compat adapter serves kinds `openai_compat` AND
  `local`. Pure translation layer (translate.ts) fixture-tested: flavors, Azure URL/api-key,
  finish-reason table, usage extraction (incl. DeepSeek cache hits), error mapping, stream
  chunk translation incl. usage-only trailing chunk merge.
- SSE client parser handles CRLF, multi-line data, split events, early cancel.
- Estimated-usage fallback (char/4) whenever a provider omits usage — flagged, never zero.
- Registry wired into server bootstrap (anthropic pending Phase 4).
- Verified: 60/60 tests incl. adapter integration against in-process OpenAI-shaped mock
  (execute + stream). Live Ollama leg NOT run — no Ollama on this dev box; run
  `pnpm tsx scripts/smoke-live.ts` on the appliance (Q-011).

## 2026-07-26 — Phase 2 complete

- Envelope frozen (src/gateway/envelope.ts + docs/envelope.md): AIRequest/AIResponse/StreamChunk,
  OpenAI-body zod parsing, developer→system normalization, canonical request hash.
- Error taxonomy with HTTP mapping + RETRYABLE_CODES for Phase 10 (errors.ts).
- Pipeline stages pure + injectable (pipeline.ts): auth (sha256 + timingSafeEqual + scopes),
  task-class fail-closed, minimal policy stage w/ max_tokens injection, scrub/ledger stubs with
  frozen interfaces, route stage with request-time local_only assertion already active.
- SSE relay with hijack(), heartbeat, [DONE], usage-after-finish chunk; mid-stream errors emit
  terminal error event. Client-disconnect via response-close (Q-010 — req.raw close is wrong and
  cost an hour of debugging; do not regress).
- Verified: 26/26 green — official openai client contract tests (both modes), 401/403/400
  taxonomy paths, upstream abort <1s on client disconnect.

## 2026-07-26 — Phase 1 complete

- 16-table schema live: db/schema.ts (drizzle, type source) + 0001_data_model up/down SQL.
  Enums for roles/kinds/statuses/sensitivity; audit event kept text (Q-005). updated_at via
  trigger; audit_log append-only enforced by trigger and test.
- Seed: demo firm + admin + local vibellm provider + 5 priced fixture models + 3 task classes
  (one per sensitivity tier) + capability-valid policies + hashed demo app token. Idempotent
  (re-run test-verified).
- Verified: typecheck/lint clean; 11/11 tests green incl. up→down→up over full schema with
  zero lingering tables, seed idempotency, append-only trigger rejection.
- Note: vitest fileParallelism disabled — DB suites share one database.

## 2026-07-26 — Phase 0 in progress

- Repo scaffolded: pnpm workspace (root server + future packages/*, ui), TS strict
  (exactOptionalPropertyTypes, noUncheckedIndexedAccess), eslint flat config (correctness only),
  prettier, vitest, tsx.
- Fastify skeleton: /healthz, /version. buildApp() separated from listen() for inject() tests.
- Env config: zod-validated, refuses boot on invalid input (src/config/env.ts). Documented in
  docs/env.md.
- Logger: pino with redaction paths for messages/choices/content/credentials — present before
  any AI traffic exists (0.10).
- Migrations: custom reversible runner (db/migrate.ts), 0000_init baseline pair.
- Docker: multi-stage node:20-alpine, non-root, healthcheck; compose dev stack pg16 + redis7
  (host ports 55433/56380), router on 8220.
- CI: typecheck / lint / up-down-up migration check / test / build / docker build with pg+redis
  services.
- DECISIONS.md D-001..D-007; QUESTIONS.md Q-001..Q-004.
- Verified locally: typecheck clean, lint clean, 9/9 tests green (incl. DB-backed up→down→up
  reversibility against compose Postgres on 55433), `pnpm build` + production boot on :8225
  answered /healthz and /version. Docker image build deferred to CI.
