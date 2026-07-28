# QA-REPORT — post-1.0.0 hardening rounds

**Context:** operator decision 2026-07-27 — app migrations (MIG-1…8) are ON HOLD until the
router has passed multiple QA rounds. This report is the record. Scope: router only.

**Summary: 8 rounds run, 20 defects found, 20 fixed, each with a permanent regression test.**
Final state: 237 tests + 37 black-box clean-room checks + e2e green; 37,500-request soak with
zero errors, −1 MB memory drift and 14.3 ms p95 added latency; installs cleanly as an
appliance app.

| Round | Focus | Findings |
| --- | --- | --- |
| A | full regression baseline | 0 (baseline) |
| B | fuzzing + correctness sweep | 5 (incl. 1 High: phantom cache-hit billing) |
| C | clean-room container from empty DB | 0 — 22/22, later 26/26 |
| D | security pass, admin + auth surface | 4 (incl. 1 High: SQL/parameter disclosure) |
| E | 25-minute soak, isolated DB | 0 — both budgets PASS |
| F | appliance integration + real install | 5 (3 High, incl. a broken nightly sync and a data-boundary misclassification) |
| G | exposure hardening (role split + Docker/UFW) | 1 appliance-wide firewall gap + 1 latent metrics bug |
| H | operator review of the role split | 4 (incl. 1 High: console published /metrics) — found by Kurt, fixed in 0.0.2 |

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

## Round F — appliance integration (installability)

Packaging the router as a Vibe-Appliance app (manifest + compose overlay + env template +
production bootstrap) and then *actually installing it* — fresh database, real container,
the exact env the appliance renders, the exact seed command it runs.

**Findings — 5, all fixed.** Every one was invisible to 229 passing tests because they live
in the gap between "the code works" and "a fresh install works".

| # | Severity | Defect | Fix |
| --- | --- | --- | --- |
| 1 | **High** | The nightly catalog sync had been **aborting partway through against the real feed since Phase 5**. Five feed entries collapse to duplicate canonical ids (`deepseek-chat` + `deepseek/deepseek-chat`); the second insert hit the unique constraint and killed the run, so only the models before the first collision were ever synced | `parseFeed` dedupes (namespaced key wins), insert is conflict-safe, and each entry is isolated so one bad row can't abort the run. Regression drives the **real** vendored feed through the DB twice |
| 2 | **High** | The vendored pricing file wasn't found in the container: the path resolved relative to source layout, so `dist/` builds got ENOENT. The sync failed *every night* in production while passing every dev-box test | resolve against both layouts (same bug class as the migrations path). Clean-room now asserts the catalog is populated |
| 3 | **High** (data boundary) | Ollama publishes **cloud-hosted** models under the same provider name as local ones (`qwen3-coder:480b-cloud`). They were imported as kind `local` — i.e. eligible for the tier defined as "never leaves the appliance" — and because they carry the largest context windows, the policy pack **preferred them** | `-cloud` ollama entries are dropped at parse; test asserts no `local` model is named `-cloud` |
| 4 | Medium | The pack picked models by context window alone, so a fresh install defaulted its local classes to a feed model the appliance's own server doesn't serve — a broken install | operator-registered (`custom`) models always beat synced entries; test pins local policies to the registered model |
| 5 | Medium | Populating the catalog made cloud-tier classes auto-assign **cloud** models on an install with no cloud provider — contradicting the reviewed "zero-cloud out of the box" decision | the pack only considers provider kinds the firm has actually configured; unserviceable classes stay unconfigured (fail closed) |

Also fixed: the manifest's default admin email (`admin@localhost`) is rejected by the login
endpoint's validation — the appliance would have created **an admin who could never sign in**.
Default is now `admin@appliance.local`, and the bootstrap validates the address at install
time rather than producing a dead account.

Verification: `console/manifests` validation (11/11 appliance tests), routing tests (4/4),
env-template render preflight (no unsubstituted markers), and a full install simulation —
container on an empty database → migrations at boot → seed command → **31/31 clean-room
checks**, serving from the operator's registered model.

## Round G — exposure hardening (role split + Docker/UFW)

Prompted by the question "if we host on the appliance, is it WAN-accessible?". The answer was
verified rather than asserted, and turned out to be *partly* — for a reason that had nothing to
do with the router's own design.

**Finding — the appliance's UFW rules never applied to Docker-published ports.**
`ufw allow`/`ufw deny` write to the INPUT chain. Docker-published traffic never traverses INPUT:
it is DNAT'd in `nat/PREROUTING` and filtered through `FORWARD → DOCKER`. So on any host with a
public IP — every DO droplet — the emergency range `:5171–:5198` (Portainer and Duplicati
included) was reachable from the internet while `ufw status` displayed it as denied. Pre-existing
and appliance-wide; not introduced by the router, but the router's console would have inherited
it as its *primary* access path.

Fixed in `lib/ufw-rules.sh`: a managed `DOCKER-USER` block written into `/etc/ufw/after.rules`
(so it reloads with UFW at boot — raw `iptables` rules would vanish on reboot) applying the same
RFC1918 + loopback + optional Tailscale-CGNAT allow-list and a catch-all `DROP`, matched on
conntrack's ORIGINAL destination port so it holds regardless of host→container port mapping.
Exercised in isolation against a temporary `after.rules`: idempotent across re-runs, preserves
pre-existing content, adds and removes the tailnet rule as the toggle changes, and never
accumulates duplicate blocks.

**Change — `ROUTER_ROLE` splits the two surfaces.** The console and the app-facing gateway shared
a port, so publishing one published both — the reason the app had to be internal-only. The same
image now runs twice:

| Container | Role | Port | Exposure |
| --- | --- | --- | --- |
| `vibe-ai-router` | `gateway` | 8220 | `vibe_net` only — no vhost, no tunnel, no host publish |
| `vibe-ai-router-console` | `console` | 8222 | Caddy vhost (HTTPS) + emergency `:5193` |

A console process answers `/v1/*` with a **JSON 404** — never the SPA shell, which a caller would
read as success. The gateway runs migrations at boot; the console sets `SKIP_MIGRATIONS=1` and
waits on the gateway's health check, so two processes never race the same schema.

**Latent bug surfaced by the split:** `Metrics` registered one gauge on prom-client's *global*
registry, so constructing a second instance in one process threw `already been registered`. One
process per deployment had hidden it since Phase 13.

**Verified:** 237 tests (3 new role-separation cases asserting each role refuses the other's
surface), both containers running the real appliance shape — migrations exactly once, console
skipping them — and **36/36 clean-room checks**, including new assertions that the published
console does not serve the gateway and that the two `/role` endpoints disagree as expected.

## Round H — operator review of the role split (findings by Kurt)

Kurt reviewed the Round G integration on the appliance branch and found four defects the
automated rounds missed — a useful record of *why* they were missed:

| # | Severity | Defect | Why QA missed it | Fix (0.0.2) |
| --- | --- | --- | --- | --- |
| 1 | **High** (information disclosure) | Publishing the console published its unauthenticated `/metrics` (per-task-class counts, provider names, breaker state) — the exact endpoint documented "never route through Caddy" in Phase 13 | the clean-room script *asserted `/metrics` reachable*, so exposure read as a pass | appliance `deny_paths` at the edge (Kurt) + `/metrics` gated to gateway-serving roles in the image; clean-room now asserts it 404s on a split console |
| 2 | Medium (duplicate writes) | Catalog sync scheduler not role-gated: both containers ran the same nightly upsert against the same tables | the rig never set `CATALOG_SYNC_CRON` on both containers | all background data work (sync, credential auto-revoke, retention purge) now runs only in gateway-serving roles; verified with the cron deliberately set on both containers |
| 3 | Medium | `emergencyPort` declared only under `subdomains[]` — the console API reported no emergency URL while HAProxy served :5193 | manifest tests validated shape, not the API's read path | top-level `emergencyPort` mirroring vibe-connect (Kurt) |
| 4 | Medium (docs) | Enable-flow docs asserted behavior that was never verified: "password resets on re-enable" and "email change creates a second admin" were both false (`state.apps.<slug>.seeded` gates the seed exactly once); `SESSION_SECRET` described as per-app when it is the shared `@JWT_SECRET@` | claims were inferred from reading code, not traced through the state gating | corrected by Kurt; lesson recorded — enable-flow claims must be exercised, not inferred |

Kurt also added `rootServedOnly` and `health_extra` manifest fields — before that, *nothing*
health-checked the gateway tier (it has no vhost, so no edge probe ever touched it).

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
