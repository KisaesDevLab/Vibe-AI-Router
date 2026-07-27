# Changelog

## 1.0.0-rc.1 — 2026-07-26

Initial release candidate. One autonomous build pass, phases 0–14 of
`VIBE-AI-ROUTER-BUILD-PLAN.md`.

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
