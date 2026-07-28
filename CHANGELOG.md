# Changelog

Versioning note: the build ran to an internal `1.0.0` (feature-complete, reviewed, QA'd), but
the **first public release is `0.0.1`** — the code has never run against a real appliance, live
model server, or production traffic. The number reflects deployment maturity, not feature
completeness. See "Not yet verified" in the README.

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
