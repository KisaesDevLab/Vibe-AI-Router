# Suite compatibility review — 2026-08-08 (QA Round J companion)

Cross-repo review of all seven integrated apps against router 0.0.5. Router-side defects
found by this review are FIXED in 0.0.5 (Q-072/Q-073/Q-074 — see CHANGELOG). This file
records the verdict per app and the items that live **outside** this repo: app-side defects
and mandatory operator steps. Effort marks follow the migration-ticket convention.

## Verdict summary

| App | Integration | Task classes | Verdict |
| --- | --- | --- | --- |
| trial-balance-app | vendored SDK 0.2.0 (byte-identical) | 3 pack + 3 registered | ✅ compatible |
| myBooks | vendored SDK 0.2.0 | 2 pack + 6 registered | ✅ wire-compatible; A2 retry defect |
| Vibe-Payroll-Time | vendored SDK 0.2.0 | 2 registered (non-pack) | ✅ after router 0.0.5 (name fix) |
| Vibe-Tax-Research-Chat | git dep sdk-v0.2.0 | 1 pack + 2 registered | ✅ partial by design (Q-070); A3/A4 |
| Vibe-Transaction-Convertor | git dep sdk-v0.2.0 | 1 pack + 2 registered | ✅ after router 0.0.5 (32k floor) |
| Vibe-Time-Billing | git dep sdk-v0.2.0 | 1 pack + 2 registered | ⚠️ works, but cost recovery is dead (A1) |
| Vibe-Calculators | git dep sdk-v0.2.0 | 1 registered | ✅ compatible; A6 nice-to-have |

All git dependencies pin `sdk-v0.2.0` at the exact 0.2.0 commit; all three vendored copies
are drift-free. Env conventions (`VIBE_AI_MODE` / `VIBE_AI_ROUTER_URL` / `VIBE_AI_TOKEN`,
refuse-to-boot) are exact in all seven apps. No app assumes router surface that does not
exist (embeddings/rerank/server-side web_search correctly stay off the router path; forced
local vision/OCR stays direct per Q-068/Q-069).

## Mandatory operator runbook (day one per firm)

**Every non-pack task class fails closed until a policy row binds it to a model.** That is
correct behavior, but it is currently an undocumented cliff: 18 registered classes across
the suite have no policy after registration —

- trial-balance-app: `tb_bank_statement_extract`, `tb_support_chat`, `tb_diagnostics`
- myBooks: `mybooks_bill_extract`, `mybooks_doc_classify`, `mybooks_statement_extract`,
  `mybooks_vendor_enrich`, `mybooks_chat`, `mybooks_report_narrative` — three of these are
  local_only **and require vision**, so a local vision-capable model must exist in the
  catalog before a policy can even be saved
- Vibe-Payroll-Time: `payroll_nl_correction` (requires tools → local model must have tool
  calling), `payroll_support_chat`
- Vibe-Transaction-Convertor: `txconv_enrichment`, `txconv_check_resolve`
- Vibe-Time-Billing: `timebill_practice_analytics`, `timebill_support_chat`
- Vibe-Tax-Research-Chat: `taxresearch_content_meta`, `taxresearch_authoring`
- Vibe-Calculators: `calc_loan_extract`

Add to the appliance provisioning checklist: after first boot of each app, open Policies →
bind default model per new class. `payroll_anomaly_review` in the pack is dead weight — the
payroll app never sends it; retire or ignore.

## App-side defect tickets

| # | App | Defect | Fix | Est. |
| --- | --- | --- | --- | --- |
| A1 | **Vibe-Time-Billing** | **AI cost recovery dead end-to-end** (the MIG-8 "separate small feature" was never built): no consumer of `GET /v1/billing/usage`; no call site passes `clientRef`, and the feed filters `client_ref IS NOT NULL` → returns zero rows regardless; admin AI-Usage page reads the app's own log which records cost 0 in router mode | thread `clientRef` through `runAiCompletion` (`apps/api/src/ai/routes.ts:1260`), build the billing-feed consumer, point AiUsage at it | M |
| A2 | myBooks | `vibe-router.provider.ts:146` re-wraps `VibeAiError` into plain `Error` — non-retryable 4xx (`policy_blocked`, `auth_error`, `budget_exceeded`) get retried with backoff; `Retry-After` never honored | preserve the `VibeAiError` (or copy `.code`/`.retryAfterSeconds`) and gate `retryWithBackoff` on `.retryable` | S |
| A3 | Vibe-Tax-Research-Chat | `opts.timeoutMs` silently dropped in router mode (`router-mode.ts:197,210`) — no `AbortSignal` passed; jobs can hang indefinitely vs the 10–300s direct-mode limits | pass `AbortSignal.timeout(opts.timeoutMs)` as `options.signal` | S |
| A4 | Vibe-Tax-Research-Chat | cache-read double-count: router wire `prompt_tokens` already includes cached tokens, and `router-mode.ts:234-237` also adds `cache_read_input_tokens` — `usage_daily` overcounts | subtract cached from prompt when synthesizing Anthropic-shaped usage | S |
| A5 | Vibe-Transaction-Convertor | truncation error reports the requested cap, not the served cap (`router-provider.ts:113`); registration declares 4096 for `txconv_statement_parse` (router 0.0.5 floors it to 32768, so this is now cosmetic) | report served `max_tokens`; align the declared default with the 32k the extraction path uses | S |
| A6 | Vibe-Calculators | forced-JSON reads `result.content` only (`packages/llm/src/router.ts:71`) — a local model answering via tool call or fenced JSON throws an unhandled parse error; SDK `completeJson` exists for exactly this | swap the hand-rolled parse for `client.completeJson` | S |
| A7 | trial-balance-app | `routerProvider.ts:118-127` forwards only `userId`/`clientRef` — `userRole`/`engagementRef` never sent, so role gating and per-engagement ledger dimensions are inert for TB | forward both headers | S |
| A8 | Vibe-Time-Billing | `x-vibe-user` carries an opaque `app_user` UUID (fine, but undocumented) and registration stamps `@unknown` under `node dist/server.js` | read version from package.json at runtime | S |
| A9 | Vibe-Tax-Research-Chat | no retry in router mode; `VibeAiError.retryable`/`retryAfterSeconds` ignored (direct path has both) | reuse the direct path's retry wrapper keyed on `.retryable` | S |

## Router-side items shipped in 0.0.5 for this review

- Q-072: fallback-scrub gap (redacted copy per cloud hop; block mode bars cloud hops).
- Q-073: firm-scoped budget state; firm+params response-cache key; estimated usage for
  dead streams; admin-API firm scoping; DB-probing `/healthz`; CSV formula-injection guard;
  keyring version guard; settings clear semantics.
- Q-074: `txconv_statement_parse` pack default 32768 + pack defaults act as registration
  floor; `payroll_anomaly_review` pack app renamed `vibe-payroll-time`.
