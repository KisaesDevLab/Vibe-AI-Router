# Vibe AI Router

The sole AI egress point for the Vibe appliance suite. Firms configure their own provider API
keys; the router enforces task-class policy, deterministic data protection, and cost
accounting. Apps never hold provider keys and never call AI providers directly.

**Port 8220** · image `ghcr.io/kisaesdevlab/vibe-ai-router` · License
[PolyForm Small Business 1.0.0](https://polyformproject.org/licenses/small-business/1.0.0)
· © 2026 KisaesDevLab

> **Licensing note:** production use is permitted for companies with **fewer than 100 total
> employees and contractors** and **under 1,000,000 USD (2019, CPI-adjusted) revenue** in the
> prior tax year. Larger organizations need a separate commercial licence from KisaesDevLab.
> There is no change date — this licence does not convert to an open-source licence on a
> clock (it replaced BSL 1.1, which did; see D-008).

## What it does

- **One OpenAI-compatible endpoint** (`POST /v1/chat/completions` + `X-Vibe-Task-Class`) for
  every Vibe app, served by two adapter families: OpenAI-compatible (OpenAI, Azure, Ollama,
  Groq, DeepSeek) and Anthropic native (with prompt caching + extended thinking).
- **Data boundary tiers** per task class — `local_only` / `cloud_deidentified` /
  `cloud_allowed` — enforced server-side on every request, with a deterministic scrubber
  (SSN/EIN/ABA/account/card) in front of all cloud egress. Fail closed, always.
- **Firm-owned keys** in a write-only encrypted vault (AES-256-GCM envelope, master-key
  rotation, staged credential rotation).
- **Deterministic cost**: exactly one ledger row per request, priced from an append-only
  pricing history; budgets (firm/app/user/task-class) with soft warnings and hard stops;
  T&B cost-recovery billing feed.
- **Resilience**: retries, per-provider circuit breakers, policy fallback chains that re-pass
  every capability/sensitivity check per hop, rate limits, load shedding, strict streaming
  fallback semantics.
- **Admin console** (React) — provider wizard, capability-gated policy editor, dashboards,
  immutable audit trail — plus Prometheus metrics and a typed app SDK
  (`@kisaes/vibe-ai-client`).

## Develop

```bash
docker compose up -d postgres redis   # dev stack (pg :55433, redis :56380)
pnpm install
pnpm migrate && pnpm seed             # demo firm; admin admin@demo.firm / vibe-router-demo-password
pnpm dev                              # router on :8220
pnpm --filter @vibe-ai-router/ui dev  # admin UI on :8221 (proxies to 8220)

pnpm typecheck && pnpm lint && pnpm test   # DB suites need VIBE_ROUTER_TEST_DATABASE_URL
pnpm --filter @vibe-ai-router/ui exec playwright test   # e2e smoke
pnpm tsx scripts/load-test.ts              # perf budget check
```

## Documentation

| Doc | Contents |
| --- | --- |
| `docs/envelope.md`, `docs/adapter-contract.md`, `docs/integration.md` | frozen contracts (wire, adapters, apps) |
| `docs/schema.md`, `docs/env.md` | data model, every env var |
| `docs/scrubber.md`, `docs/threat-model.md` | data protection + STRIDE-lite |
| `docs/runbook.md`, `docs/appliance.md` | operations, deployment |
| `docs/firm/*` | firm-facing: setup, where-your-data-goes, FAQ, §7216 draft |
| `docs/migration-playbook.md`, `docs/migration-tickets.md` | app onboarding |
| `PHASES.md` / `STATE.md` / `QUESTIONS.md` / `DECISIONS.md` / `SENSITIVITY-REVIEW.md` | build record + Phase 15 review agenda |

## Status

**`0.0.1` — first public release. Feature-complete and heavily tested, but not yet run in
production.** The low version number is deliberate: it reflects deployment maturity, not
missing features.

Verified: 237 automated tests (unit, integration, invariant, chaos, property-based, fuzz,
security), 36 black-box acceptance checks against a container built from an empty database, a
Playwright end-to-end pass, a 37,500-request soak (0 errors, no memory drift), and seven
post-review QA rounds that found and fixed 16 defects (`QA-REPORT.md`).

**Not yet verified — needs real hardware:**

- live completions against a real model server (all model traffic in tests is mocked);
- Caddy/TLS ingress and `SECURE_COOKIES=true` end to end;
- a memory soak on appliance hardware rather than a dev box;
- the shadow-diff report against a real model (the harness is proven on a deterministic mock);
- the `DOCKER-USER` firewall rules against real packets (rule *generation* is tested).

Treat it as pre-production until those are done. Install path: `docs/appliance.md`.
