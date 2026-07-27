# QA-REPORT — post-1.0.0 hardening rounds

**Context:** operator decision 2026-07-27 — app migrations (MIG-1…8) are ON HOLD until the
router has passed multiple QA rounds. This report is the record. Scope: router only.

## Round A — full regression (automated)

| Suite | Result |
| --- | --- |
| typecheck (strict, exactOptionalPropertyTypes) + eslint | clean |
| unit / integration / invariant / chaos / property (vitest) | **216/216** |
| migration reversibility up→down→up + zero-lingering-tables | green |
| Playwright e2e (login → wizard → policy → live request → audit) | green |
| load test 50 rps × 30 s mixed streaming/non-streaming | 0 errors, added latency p50 12.6 ms / **p95 18.0 ms** (< 25 ms budget) |
| `pnpm audit --prod` | 0 vulnerabilities |

## Round B — adversarial (fuzzing + manual risk-path sweep)

New permanent suite: `test/qa-round-b.test.ts` (~6,500 generated cases per run):

- `toEnvelope` fuzz (arbitrary JSON + adversarial message shapes): valid envelope or
  `RouterError` — never an uncontrolled crash.
- Adapter translators fuzz (openai chunk/response, anthropic events): tolerate arbitrary
  provider bytes.
- Scrubber properties: redaction idempotent (`redact∘redact = redact`), span sanity on
  digit-soup inputs.

**Manual sweep findings — 5, all fixed same day with regression tests:**

| # | Severity | Defect | Fix |
| --- | --- | --- | --- |
| 1 | Medium | Streaming responses dropped the `x-vibe-budget-warning` header (`writeHead` after `hijack()` discards `reply.header()` values) | header re-added in the SSE `writeHead`; regression test asserts it on a streamed response |
| 2 | **High** (money-correctness) | Cache-hit ledger rows replayed the cached response's token counts and recomputed cost — phantom spend/budget consumption for requests that never touched a provider (material if `cache_cloud` + priced model) | cache hits ledger zero usage / zero cost; regression proves row 1 costs > 0, row 2 costs 0 |
| 3 | Medium (resource leak) | Client abort after the first stream chunk could strand the primed generator → per-provider load-shed slot + idle timer leaked until process restart | wrapper `finally` drives `gen.return()`; regression polls shed stats back to 0 after abort |
| 4 | Low (latent, multi-tenant) | Per-task-class budget SUM was not firm-scoped (harmless single-firm, wrong the day a second firm exists) | `firm_id` added to the WHERE |
| 5 | Low | Billing feed period used an inclusive end bound — a row stamped exactly at month boundary would bill in two periods | half-open interval (`>= start AND < end`) |

## Round C — clean-room deployment (black-box, from scratch)

Production image rebuilt with the fixes, booted against a **brand-new empty database**
(migrations ran at container start: 0000→0002), seeded, model server mocked at the network
edge. `scripts/qa-clean-room.ts` (kept as the standing appliance acceptance script) ran
**22/22 checks green** over HTTP only: liveness/version/UI/metrics, admin session lifecycle +
authz rejections, fail-closed gateway boundaries (missing header 403 / bad token 401 / unknown
class 403), non-streaming + streaming completions, local-tier scrubber exemption, audit and
ledger evidence with request-id + client-ref dimensions and **no prompt bodies anywhere**,
billing feed.

## Standing QA assets (run these every round)

```bash
pnpm test                                      # includes invariant + chaos + Round B fuzz
pnpm --filter @vibe-ai-router/ui exec playwright test smoke
pnpm tsx scripts/load-test.ts                  # perf budget gate
ROUTER_URL=… pnpm tsx scripts/qa-clean-room.ts # black-box acceptance (any deployment)
```

## Verdict + what QA still cannot cover on this dev box

Router is release-quality for appliance deployment. Deliberately out of reach until first
deploy (tracked Q-011/Q-054): live vibellm completions (`scripts/smoke-live.ts`), 1-hour
memory soak on appliance hardware, real-model shadow-diff report, Caddy/TLS integration.
App migrations remain on hold per operator decision (Q-058/Q-059) until QA sign-off.
