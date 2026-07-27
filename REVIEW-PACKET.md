# REVIEW-PACKET — Vibe AI Router v1.0.0-rc.1

**✅ 15B COMPLETE — answered by Kurt in Q&A, 2026-07-27. Verdicts recorded below; 15C executed
same day. Summary: KEEP everything except → 4a scrubber default CHANGE to `redact`; 7a CHANGE
to Node 24; 15C GO with the TB call-site swap (MIG-1) deferred to its own scheduled ticket.**

| Item | Verdict |
| --- | --- |
| 1a taxresearch_chat tier | KEEP cloud_allowed |
| 1b doc-extract tiers | KEEP cloud_deidentified |
| 1 remaining 12 rows | KEEP all |
| 2a Fastify | KEEP (batched) |
| 3a/3b/3c pack defaults + limits | KEEP local-first everywhere |
| 4a scrubber default | **CHANGE → redact** (applied: code default, seed, docs; block remains per-firm option) |
| 4b structural determinism | KEEP |
| 5a budgets | KEEP none by default |
| 6a/6b/6c port 8220 / airouter / BSL 1.1 | KEEP |
| 7a runtime | **CHANGE → Node 24** (applied: image, engines, CI) |
| 7b admin auth | KEEP as-is (no throttling; SSO backlog) |
| 7c–7j batched | KEEP all |
| 15C go/no-go | **GO — skip TB swap** (MIG-1 scheduled separately; direct-path flag removal moves with it) |

---

**For:** Kurt (Phase 15B — the only human touchpoint of this build)
**Rule of engagement:** every agenda item is a closed question with the implemented default
stated. Answer inline: `KEEP` or `CHANGE: <instruction>`. Items are ordered by consequence.
Target: one sitting. Everything referenced is in this repo; the demo runs locally
(§ Demo environment, bottom).

---

## One-page architecture

One container (`vibe-ai-router`, port 8220) + the shared appliance Postgres. Every Vibe app
sends AI traffic to `POST /v1/chat/completions` (OpenAI-compatible) with an app token and a
required `X-Vibe-Task-Class` header, via `@kisaes/vibe-ai-client`. Pipeline per request:

```
auth → resolve class → policy (tier/capability/role/limits) → budget → scrub (cloud-bound)
     → route (SSRF gate, credential decrypt) → adapt (retry/breaker/fallback per hop)
     → ledger (exactly one row) → audit + metrics
```

Two adapter families translate the internal envelope at the edge: OpenAI-compat
(OpenAI/Azure/Ollama/Groq/DeepSeek) and Anthropic native (caching, thinking). Catalog + $/MTok
pricing sync from a vendored LiteLLM snapshot. Admin console (React) behind
`airouter.<domain>`; prompt bodies are never persisted anywhere (CI-enforced invariant).

Evidence: 206 tests + Playwright e2e green · chaos suite · property tests · load test 50 rps
p95 **+19.6ms** added latency (<25ms budget) · pnpm audit clean · threat model
(docs/threat-model.md) · production image smoke-tested.

---

## Agenda item 1 — SENSITIVITY ASSIGNMENTS (the compliance-critical one)

Review **SENSITIVITY-REVIEW.md** row by row (14 task classes, 8 apps). Every row was assigned
under "when in doubt: local_only". The two rows most worth your attention:

- **1a.** `taxresearch_chat` = **CLOUD** on the claim that research chat carries no client
  facts by construction. If staff paste client facts into research chat, the scrubber still
  screens TINs/accounts (it IS scrubbed — Q-029 makes every cloud-bound request pass the
  scrubber) but names/narratives would flow. Currently CLOUD — keep, or CHANGE to
  cloud_deidentified?
- **1b.** `mybooks_receipt_extract` and `tb_doc_extract` = **SCRUBBED** (cloud after
  deterministic scan). Comfortable with scanned receipts/source docs going to the firm's cloud
  account post-scrub, or CHANGE to local_only until real-world scrubber telemetry exists?

## Agenda item 2 — decisions with L reversal cost

- **2a. Fastify (D-002).** The only L-cost decision on the books; mitigated by pure-function
  handlers. Working, fast, contract-tested. Currently Fastify — KEEP is expected; flagging
  because the plan requires L items surfaced.

## Agenda item 3 — default policy pack models/limits

- **3a.** Local default model = `ollama/qwen3:14b` for every local_only class (pack picks the
  largest-context capable local model at apply time). Correct default for your vibellm box —
  KEEP or CHANGE to a specific model per class?
- **3b.** Cloud-tier pack defaults are LOCAL-first too (a cloud-permitted class still starts
  on a local model; the admin opts into cloud per class). Currently local-first everywhere —
  KEEP or CHANGE to cloud defaults for the two cloud tiers?
- **3c.** Default max_tokens per class: 1024–8192 (SENSITIVITY-REVIEW/pack). KEEP or CHANGE?

## Agenda item 4 — scrubber default mode

- **4a.** Firm default `block` (reject cloud-bound requests containing SSN/EIN/routing/
  account/card; types+counts in the error, never values). Alternatives: `redact` ([SSN]
  tokens) or `warn`. Currently **block** — KEEP?
- **4b.** Structural determinism means phone-shaped `555-12-3456` blocks as an SSN (Q-031).
  Acceptable false-positive posture — KEEP?

## Agenda item 5 — budget defaults

- **5a.** No budgets configured out of the box (spend is unlimited until the admin sets one;
  soft warning at 80% once set). Currently none — KEEP, or CHANGE to ship a conservative
  default (e.g. $50/month firm cap) on new installs?

## Agenda item 6 — naming / port / exposure

- **6a.** Port **8220** (plan said 8300 — collided with Vibe-1099's dev mock; suite audit in
  D-003). KEEP?
- **6b.** Subdomain **airouter.<domain>**, admin UI only through Caddy; app traffic +
  /metrics internal-network only (D-004/Q-051). KEEP?
- **6c.** License BSL 1.1 → Apache-2.0 at 4 years (D-001, matches Vibe TB). KEEP?

## Agenda item 7 — batched, lower consequence (KEEP unless you feel otherwise)

- **7a.** Node 20 runtime vs suite's newer Node 24 (Q-002).
- **7b.** Admin auth = local email+password (scrypt), sessions reset on restart unless
  SESSION_SECRET set; no login throttling yet (Q-042/Q-052). Suite SSO stays backlog.
- **7c.** Registration forces NEW task classes to local_only; only admin UI can widen (Q-025/45).
- **7d.** Advisory `model` honored only when allowed+valid, else policy default, silently
  (Q-024).
- **7e.** In-memory breaker/rate-limit/cache state — Redis seam exists, unused (Q-038).
- **7f.** Audit log immutable forever; retention env covers usage_ledger only (Q-050).
- **7g.** Ledger rows only for authenticated requests (Q-033).
- **7h.** json_schema on Anthropic via forced tool (Q-014).
- **7i.** Unknown feed models → catalog `deprecated`, never deleted; custom rows never touched
  (5.3).
- **7j.** Cache hits write ledger rows (Q-049); response cache off unless a class opts in.

## The two staged items (decisions already documented, work scheduled)

- **TB migration (Q-047):** router side complete; the `trial-balance-app` call-site swap is
  MIG-1 in docs/migration-tickets.md, to land in this Phase-15 window with the live
  shadow-diff report (harness proven at 100% on deterministic mock). Approve scheduling?
- **First-deploy verifications (Q-011/Q-054):** live vibellm smoke (`scripts/smoke-live.ts`)
  and the 1-hour memory soak run on the appliance, not the dev box.

## Full logs for reference

- **QUESTIONS.md** — 55 decisions, grouped by phase, each with rationale + refactor cost
  (no L-cost entries; M-cost: Q-001 migrations, Q-012 flavor detection, Q-014 schema-tool,
  Q-036 task-class budgets, Q-038 Redis seam, Q-042 auth, Q-047 TB staging).
- **DECISIONS.md** — D-001…D-007. **SENSITIVITY-REVIEW.md** — agenda item 1.
- **docs/threat-model.md** — T1–T6 with residuals. **CHANGELOG.md** — rc.1 contents.
- Load test: `pnpm tsx scripts/load-test.ts` (last run: 3000 req, 0 errors, +19.6ms p95).
- Screenshots: `docs/screenshots/01…08` (login → dashboard → providers → catalog → policies →
  editor → audit → settings).

## Demo environment (15.4)

```bash
docker compose up -d postgres redis
pnpm install && pnpm migrate && pnpm seed
pnpm dev                                   # router :8220 (serves built UI if ui/dist exists)
pnpm --filter @vibe-ai-router/ui build     # or: …/ui dev → :8221
```

Walkthrough: sign in (`admin@demo.firm` / `vibe-router-demo-password`) → watch the FULLY LOCAL
lamp → Providers → Add provider (wizard) → Policies → edit `tb_classification` (note: only
local models offered) → Dashboard → Send test prompt → Audit log shows the request →
Settings → budgets. Optional live model leg: point the seeded local provider at a real Ollama
and re-run the test prompt.

---

*After 15B: record every answer inline above; CHANGEs execute per 15C (re-run invariant +
chaos + e2e; TB flag removal 15.8; docs sync 15.9; second shadow-diff if classification
behavior changed 15.10; then tag 1.0.0 and deploy to the firm).*
