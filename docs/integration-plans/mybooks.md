# Runbook — myBooks

**Identity `vibe-mybooks` · vendored SDK 0.2.0 · dual-mode · shipped MIG-2 (Q-069)**

Wire-compatible today. This runbook covers provisioning all eight classes, the error-handling
fix (A2), and the new R4 option to route OCR/vision through the router.

## 1. Appliance provisioning

Shared P1–P8. App-specifics:

- **Models needed (P2/P3):** local json_schema chat model; **a local VISION model** — either
  an Ollama vision model (`llama3.2-vision:11b`) on the `local` provider or `glm/GLM-OCR`
  on the `local_ocr` provider (R4, router ≥ 0.0.6). Without one, policies for the three
  vision classes cannot be saved (config-time capability gate).
- **Token (P5):** identity `vibe-mybooks`.
- **Policy rows (P7):** eight classes.

| Class | Tier | Requires | Bind to |
| --- | --- | --- | --- |
| `mybooks_txn_categorize` | local_only (seeded) | json_schema | local qwen3 |
| `mybooks_receipt_extract` | cloud_deidentified (seeded) | json_schema+vision | cloud vision model (scrubbed) or local vision |
| `mybooks_bill_extract` | local_only (registered) | json_schema+**vision** | local vision model / `glm/GLM-OCR` |
| `mybooks_doc_classify` | local_only (registered) | json_schema | local qwen3 |
| `mybooks_statement_extract` | local_only (registered) | json_schema+**vision** | local vision model / `glm/GLM-OCR` |
| `mybooks_vendor_enrich` | local_only (registered) | json_schema | local qwen3 (widen to cloud if desired — P8) |
| `mybooks_chat` | local_only (registered) | — | local chat model |
| `mybooks_report_narrative` | local_only (registered) | — | local chat model (cloud-widen candidate) |

## 2. App configuration

```
VIBE_AI_MODE=router
VIBE_AI_ROUTER_URL=http://vibe-ai-router:8220
VIBE_AI_TOKEN=<minted vibe-mybooks token>
```

Router mode short-circuits `executeWithFallback` (`ai-providers/index.ts:194-196`) — the
router owns fallback. Boot registration retries with backoff.

## 3. Code changes owed

**A2 — preserve the router error taxonomy** (`packages/api/src/services/ai-providers/vibe-router.provider.ts:146`).
Today every `VibeAiError` is re-wrapped into `new Error(message)`, so `retryWithBackoff`
(`utils/retry.ts:92-95`) retries non-retryable 4xx (`policy_blocked`, `auth_error`,
`budget_exceeded`) and never honors `Retry-After`. Fix: rethrow the original `VibeAiError`
(or a wrapper carrying `.code`, `.status`, `.retryAfterSeconds`, `.retryable`) and gate the
retry helper on `err.retryable === true`, using `retryAfterSeconds` as the first delay.
*Effort S.*

**Optional (R4) — route the pinned-local OCR paths through the router.** Q-069 kept the
qwen extraction pipeline + GLM-OCR `forceDirect` in both modes; with router ≥ 0.0.6 that
pinning may be replaced by router policies (page images to `glm/GLM-OCR` via `local_ocr` —
still on-box, still scrubber-exempt, now with ledger visibility and console-switchable
models). If adopted: point the OCR call sites at the SDK with a vision content part
(`{type:'image_url', image_url:{url:'data:image/png;base64,…'}}`) under
`mybooks_statement_extract` / `mybooks_bill_extract`, and drop the `forceDirect` flags.
Keep direct mode as the non-router deployment path. *Effort M — do after A2.*

## 4. Verification (universal gate + myBooks-specific)

1. Categorize a bank feed batch → ledger rows for `mybooks_txn_categorize` at cost 0.
2. Receipt upload → `mybooks_receipt_extract`; cloud-bound path shows scrub events for a
   fixture containing a card number (Luhn-valid).
3. Post-A2: disable a class's policy → the app surfaces the error immediately (no backoff
   retry storm in its logs); a router 429 is retried after the advertised delay.
4. Vision classes: statement page extraction completes against the bound local vision
   model; if `glm/GLM-OCR`, confirm the request appears in the router ledger under
   `local_ocr` with cost 0.
5. App-side consent + per-company toggles still gate features (they sit on top of router
   policy, not instead of it).
