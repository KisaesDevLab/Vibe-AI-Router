# Runbook — Vibe Time & Billing

**Identity `vibe-time-billing` · SDK git dep `sdk-v0.2.0` · dual-mode · MIG-8 shipped INCLUDING
A1 cost recovery (TB 5bbe405) · mode switch in Admin → AI settings (TB 0222) · AI file naming
(TB 0223, `timebill_file_naming`)**

The wire integration is clean: all AI call sites mapped through `FEATURE_TASK_CLASS`
(`apps/api/src/ai/vibe-router.ts`), unknown features fail closed before any wire traffic. A1
(cost recovery) and A8 (runtime version stamp) shipped app-side — the "code changes owed"
section from earlier revisions of this runbook is done.

## 1. Appliance provisioning

Shared P1–P8. App-specifics:

- **Token (P5):** identity `vibe-time-billing`.
- **Cloud provider (P4)** for `tb_invoice_narrative` (cloud_deidentified).
- **Policy rows (P7):**

| Class | Tier | Requires | Bind to |
| --- | --- | --- | --- |
| `tb_invoice_narrative` | cloud_deidentified (seeded) | — | cloud drafting model (scrubbed) |
| `timebill_practice_analytics` | local_only (seeded, Q-081) | — | local chat model (cloud-widen candidate, P8) |
| `timebill_support_chat` | local_only (seeded, Q-081) | — | local chat model |
| `timebill_file_naming` | cloud_deidentified (seeded, Q-086/Q-087) | vision + json_schema | local vision model first; DigitalOcean `kimi-k2.5`/`kimi-k2.6` are the catalog's vision+JSON cloud options (bind as allowed/fallback). **No capable model bound → the feature fails closed by design.** Note: the scrubber redacts text parts only — page images reach a cloud model unscrubbed (accepted, Q-087). On an appliance where the class already exists as local_only, widen it in the router admin console — pack seeding and app registration never change an existing class's tier. |

## 2. App configuration

Since TB 0222 the routing mode lives in **Admin → AI settings** (`firm_config.ai_mode`:
`env | direct | router`, router URL + MFK-wrapped token stored per firm). The env vars remain
the appliance-level default that `ai_mode=env` resolves to:

```
VIBE_AI_MODE=router
VIBE_AI_ROUTER_URL=http://vibe-ai-router:8220
VIBE_AI_TOKEN=<minted vibe-time-billing token>
```

Switching to router in the admin UI re-registers task classes at runtime, and
`POST /ai-mode/test` registers them against a candidate router as the connection probe — so a
router that is up when the admin saves will have all four classes without an app restart. A
half-configured router (URL without token, or vice versa) degrades to direct **in the app's
mode resolution** with a stated problem; once in router mode there is still no silent per-call
fallback to direct.

## 3. Attribution / cost recovery (A1 — shipped, TB 5bbe405)

- `x-vibe-user` carries the internal `app_user` UUID (per-user budgets key on it; portal
  callers send none). `x-vibe-client` / `x-vibe-engagement` carry internal client/engagement
  UUIDs; attribution rides headers only, never prompt text.
- TB's worker `ai-cost-sync` (daily 04:23) pulls `/v1/billing/usage` for the current +
  previous UTC month into its `client_ai_costs` table (migration 0214); the admin AI-Usage
  page reads it in router mode. Rows without `client_ref` are filtered from the billing feed
  by construction — expect free-text features (pricing card, reason-code without SPA caller)
  to appear in the ledger but not in cost recovery.

## 4. Verification (universal gate + billing-specific)

1. Invoice narrative polish → `tb_invoice_narrative` in the router ledger with a real cost and
   `client_ref` populated.
2. `GET /v1/billing/usage?period=<this month>` with the app token returns line items whose
   cost sums match the Dashboard spend for `vibe-time-billing`.
3. TB's `ai-cost-sync` populates `client_ai_costs`; the admin AI-Usage page shows non-zero,
   per-client costs that reconcile with the router ledger.
4. Analytics + support chat serve locally at cost 0 (they appear in usage but not in
   cost-recovery, by construction — local is free).
5. File naming: upload a document → `timebill_file_naming` row in the ledger served by a local
   vision model, JSON response valid. With no vision+json_schema local model bound, the call
   is rejected with a clear capability error (fail closed — confirm it does NOT silently
   degrade to text-only).
