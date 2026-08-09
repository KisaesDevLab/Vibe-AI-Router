# Runbook — trial-balance-app (Vibe TB)

**Identity `vibe-tb` · vendored SDK 0.2.0 (`server/src/lib/vibeAiClient.ts`, drift-free) · dual-mode · shipped MIG-1**

Integration is live and wire-verified. This runbook takes a fresh appliance from zero to
fully served, plus the one code change still owed (A7).

## 1. Appliance provisioning

Run shared steps P1–P8 (README). App-specifics:

- **Models needed locally (P2):** a json_schema-capable chat model (proven: `qwen3:14b`).
- **Token (P5):** identity `vibe-tb`.
- **Policy rows (P7):** six classes.

| Class | Tier | Requires | Bind to |
| --- | --- | --- | --- |
| `tb_classification` | local_only (seeded) | json_schema | local qwen3 (policy seeded by pack when local provider exists) |
| `tb_doc_extract` | cloud_deidentified (seeded) | json_schema+vision | cloud vision model (Anthropic/DO) or local vision model; scrubber clears before cloud |
| `tb_research_summary` | cloud_allowed (seeded) | — | cloud model of choice; add a second-provider fallback |
| `tb_bank_statement_extract` | local_only (registered) | json_schema | local qwen3; consider `glm/GLM-OCR` upstream via R4 later |
| `tb_support_chat` | local_only (registered) | — | local chat model |
| `tb_diagnostics` | local_only (registered) | — | local chat model |

## 2. App configuration

```
VIBE_AI_MODE=router
VIBE_AI_ROUTER_URL=http://vibe-ai-router:8220
VIBE_AI_TOKEN=<minted vibe-tb token>
```

Boot order: router healthy → app boots → registration at `app.ts:335` →
`routerProvider.ts:262-305` declares the three non-pack classes. `aiClient.ts:62` throws if
router mode is set but unreachable — there is deliberately no silent direct fallback.

## 3. Code change owed (A7) — attribution headers

`server/src/lib/routerProvider.ts:118-127` forwards only `userId`/`clientRef`. Add:

```ts
...(opts.userRole ? { userRole: opts.userRole } : {}),
...(opts.engagementRef ? { engagementRef: opts.engagementRef } : {}),
```

threaded from the request context at each call site (csvImport.ts:445/613/724,
pdfImport.ts:264/650/797, support.ts:147). Without this, router role gating and
per-engagement ledger dimensions are inert for TB. *Effort S.*

## 4. Verification (universal gate + TB-specific)

1. CSV import → classification rows land; ledger shows `tb_classification` at cost 0.
2. PDF import → `tb_doc_extract`; if bound to cloud, audit shows `scrubber_redacted` when
   the fixture contains a TIN.
3. Support chat streams; `[DONE]` received; single ledger row with usage.
4. Stop vibellm with a `tb_doc_extract` local+cloud chain configured → fallback hop fires
   and the cloud leg is REDACTED (Q-072; check audit).
5. Shadow-diff: `scripts/smoke-live.ts` + the TB shadow harness against live vibellm
   (standing Q-011 item) — attach the report, then retire the app's direct path (15.8).
6. Post-A7: make a request with a staff user on a role-denied class → `policy_blocked`;
   ledger row carries the engagement ref.
