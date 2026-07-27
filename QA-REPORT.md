# QA-REPORT — post-1.0.0 hardening rounds

**Context:** operator decision 2026-07-27 — app migrations (MIG-1…8) are ON HOLD until the
router has passed multiple QA rounds. This report is the record. Scope: router only.

**Summary: 5 rounds run, 9 defects found, 9 fixed, each with a permanent regression test.**
Final state: 229 tests + 26 black-box clean-room checks + e2e green; 37,500-request soak with
zero errors, −1 MB memory drift and 14.3 ms p95 added latency.

| Round | Focus | Findings |
| --- | --- | --- |
| A | full regression baseline | 0 (baseline) |
| B | fuzzing + correctness sweep | 5 (incl. 1 High: phantom cache-hit billing) |
| C | clean-room container from empty DB | 0 — 22/22, later 26/26 |
| D | security pass, admin + auth surface | 4 (incl. 1 High: SQL/parameter disclosure) |
| E | 25-minute soak, isolated DB | 0 — both budgets PASS |

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

## Round D — security pass on the admin + auth surface

New permanent suite: `test/qa-round-d-security.test.ts` — 13 checks, every one an attack that
must fail or a leak check that must come up empty. Probes: privilege escalation with a real
non-admin session, CSRF coverage across **all 12** mutating routes, session-cookie forgery
(bad signature / swapped id / stripped signature), credential-disclosure sweep over every
readable endpoint, mint-once app tokens, revoked + unscoped token rejection, prototype
pollution, SQL/traversal-shaped params, SSRF via the admin API (both directions), gateway
error disclosure, login user-enumeration timing, session-store growth.

**Findings — 4, all fixed:**

| # | Severity | Defect | Fix |
| --- | --- | --- | --- |
| 1 | **High** (information disclosure) | Any unhandled route error returned Fastify's default body, which echoes `err.message`. A DB driver error therefore returned **the full SQL statement plus bound parameter values** (including firm UUIDs) to the caller. Triggered here by a NUL byte in a query param | global `setErrorHandler`: 5xx → generic `{message:'internal error', code:'unknown'}`, real error logged server-side only; 4xx keep their message. Protects every current and future route |
| 2 | Medium | A NUL byte (or any C0 control char) in an admin query param reached Postgres, which rejects it — producing that 500 instead of a clean 400 | `safeString()` zod guard on all DB-bound filter params (`event`, `app`, `search`, `status`) → 400 |
| 3 | Medium | Login user-enumeration oracle: unknown email returned **~17× faster** (1.7 ms) than a wrong password for a known one (28.8 ms), because the scrypt verify was skipped entirely | unknown emails now verify against a pre-computed dummy hash; the hash is warmed at registration so the first request doesn't leak the same signal by another route. Measured ratio now < 3× |
| 4 | Medium (DoS) | `SessionStore` grew without bound — and login has no throttle by decision (Q-052), so repeated logins were an unauthenticated slow memory-exhaustion vector | hard cap (1000) with expired-entry sweep + soonest-to-expire eviction on insert; `size` exposed for assertions |

Checks that passed first time (no change needed): role-based authorization on all 11 read
endpoints, CSRF header enforcement on all 12 mutations, cookie forgery resistance, zero
credential/ciphertext/password-hash disclosure across every endpoint including a failing
provider test, mint-once tokens, revoked/unscoped token rejection, prototype-pollution
immunity, SQL-injection immunity (parameterized throughout), SSRF gates in both directions,
and no provider labels/hostnames/stack frames in app-facing gateway errors.

## Round E — extended soak

25-minute continuous run at 25 rps against an **isolated database**, RSS/heap sampled every
60 s (25 samples).

| Metric | Result |
| --- | --- |
| Requests | **37,500 sent, 0 errors** |
| Latency (router) | p50 14.5 ms · p95 19.1 ms · p99 24.6 ms |
| **Added latency** vs direct-to-mock baseline | p50 12.2 ms · **p95 14.3 ms** (budget < 25 ms) → PASS |
| Memory drift, mid-run avg → late avg | 356 MB → 355 MB = **−1 MB** (budget < 50 MB) → PASS |
| RSS profile | flat 354–356 MB for the final 20 minutes; heap sawtooth 62–187 MB (healthy GC) |

No leak signature: RSS is flat to within 2 MB across the last 20 minutes, and the heap
oscillates rather than ratchets. The `start=243MB → end=356MB` delta is warm-up (JIT, pools,
37.5k timer allocations in the harness itself), which is exactly why the budget compares
mid-run against late-run rather than start against end.

> Method note: the first soak attempt was **discarded, not reported** — Round D's suite calls
> `resetDb`, which drops every table, against the database that soak was using. Isolating the
> soak database was the fix; the contaminated run's numbers would have measured test
> interference, not the router.

## Standing QA assets (run these every round)

```bash
pnpm test                                      # includes invariant + chaos + Round B fuzz
pnpm --filter @vibe-ai-router/ui exec playwright test smoke
pnpm tsx scripts/load-test.ts                  # perf budget gate
ROUTER_URL=… pnpm tsx scripts/qa-clean-room.ts # black-box acceptance (any deployment)
```

## Verdict + what QA still cannot cover on this dev box

Router is release-quality for appliance deployment. Five rounds moved it from "all tests pass"
to "attacked, fuzzed, soaked, and deployed from scratch" — the two High-severity findings
(phantom billing on cache hits; SQL + parameter disclosure in unhandled errors) were both
invisible to the original suite because each needed a config combination or an input class no
happy-path test produces.

Deliberately out of reach here, deferred to first deploy (Q-011/Q-054):

- live vibellm completions (`scripts/smoke-live.ts`) — dev box has no Ollama;
- soak on **appliance hardware** — the 25-min dev-box soak proves no leak in the code, not
  behavior under the appliance's memory ceiling and disk;
- real-model shadow-diff report (harness proven at 100% on deterministic mock);
- Caddy/TLS + `SECURE_COOKIES=true` end-to-end.

App migrations remain ON HOLD per operator decision (Q-058/Q-059) until explicit sign-off.
