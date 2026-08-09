# Runbook — Vibe Time & Billing

**Identity `vibe-time-billing` · SDK git dep `sdk-v0.2.0` · dual-mode · shipped MIG-8 — cost recovery NOT yet built**

The wire integration is clean (all 14 AI call sites mapped, unknown features fail closed).
The remaining work is the MIG-8 headline feature itself: AI cost recovery (A1), which is
currently dead end-to-end.

## 1. Appliance provisioning

Shared P1–P8. App-specifics:

- **Token (P5):** identity `vibe-time-billing`.
- **Cloud provider (P4)** for `tb_invoice_narrative` (cloud_deidentified).
- **Policy rows (P7):**

| Class | Tier | Requires | Bind to |
| --- | --- | --- | --- |
| `tb_invoice_narrative` | cloud_deidentified (seeded) | — | cloud drafting model (scrubbed) |
| `timebill_practice_analytics` | local_only (registered) | — | local chat model (cloud-widen candidate, P8) |
| `timebill_support_chat` | local_only (registered) | — | local chat model |

## 2. App configuration

```
VIBE_AI_MODE=router
VIBE_AI_ROUTER_URL=http://vibe-ai-router:8220
VIBE_AI_TOKEN=<minted vibe-time-billing token>
```

## 3. Code changes owed

**A1 — build AI cost recovery end-to-end.** Three pieces, in order (*effort M total*):

1. **Send attribution.** `runAiCompletion` (`apps/api/src/ai/routes.ts:1260-1267`) does
   not accept `clientRef`/`engagementRef`; the driver passthrough already exists
   (`vibe-router.ts:107`). Thread the client id (and matter where known) from each of the
   14 call sites' request context. Without `clientRef`, the router's billing feed filters
   the rows out (`client_ref IS NOT NULL`) and NOTHING downstream can ever work.
2. **Consume the feed.** Monthly job calling SDK `client.billingUsage('YYYYMM')` →
   upsert into a `client_ai_costs` table (period, clientRef, taskClass, requests, tokens,
   costCents). The endpoint is live router-side (`/v1/billing/usage`, app-token authed).
3. **Surface it.** Point the admin AI-Usage page (`apps/web/src/pages/admin/AiUsage.tsx`)
   at `client_ai_costs` in router mode — today it reads the app's own `ai_request_log`,
   which records `costEstimateCents: 0` in router mode (`vibe-router.ts:119`) and shows $0.
   Optionally emit WIP entries per client for markup-and-recover billing.

**A8 — hygiene**: registration version stamps `@unknown` under `node dist/server.js`
(`vibe-router.ts:186`) — read version from package.json at runtime. Document that
`x-vibe-user` carries the internal `app_user` UUID (per-user budgets key on it).

## 4. Verification (universal gate + billing-specific)

1. Invoice narrative polish → `tb_invoice_narrative` in the router ledger with a real cost
   and the CLIENT REF populated (post-A1 step 1 — check the ledger row's `client_ref`).
2. `GET /v1/billing/usage?period=<this month>` with the app token returns line items whose
   cost sums match the Dashboard spend for `vibe-time-billing`.
3. Month-end job populates `client_ai_costs`; the admin AI-Usage page shows non-zero,
   per-client costs that reconcile with the router ledger.
4. Analytics + support chat serve locally at cost 0 (they appear in usage but not in
   cost-recovery, by construction — local is free).
