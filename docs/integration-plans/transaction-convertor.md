# Runbook — Vibe Transaction Convertor (TxConvertor)

**Identity `vibe-tx-converter` · SDK git dep `sdk-v0.2.0` · dual-mode, text passes routed (Q-068) · shipped MIG-6**

Statement/enrichment/check TEXT passes route; page-image OCR stays direct by default (with
an R4 option to route it). **Router ≥ 0.0.5 is mandatory** — earlier routers clamp
`txconv_statement_parse` output to 4096 tokens and multi-page extraction hard-fails.

## 1. Appliance provisioning

Shared P1–P8. App-specifics:

- **Router ≥ 0.0.5** (32k output floor for `txconv_statement_parse`; ≥ 0.0.6 for the R4
  OCR option).
- **Token (P5):** identity `vibe-tx-converter`.
- **Local model must sustain ~32k output** for statement parse — verify the Ollama model's
  output config; clamp down via policy `maxTokensOverride` only if it genuinely cannot
  (that reintroduces truncation on the largest statements — prefer a capable model).
- **Policy rows (P7):**

| Class | Tier | Requires | Bind to |
| --- | --- | --- | --- |
| `txconv_statement_parse` | local_only (seeded) | json_schema | local qwen3 (32k output) |
| `txconv_enrichment` | local_only (registered) | json_schema | local qwen3 |
| `txconv_check_resolve` | local_only (registered) | json_schema | local qwen3 |

**Keep these local_only** — full statements carry account numbers throughout (Q-068).

## 2. App configuration

```
VIBE_AI_MODE=router
VIBE_AI_ROUTER_URL=http://vibe-ai-router:8220
VIBE_AI_TOKEN=<minted vibe-tx-converter token>
```

`GLM_OCR_URL` stays set — the OCR path is direct unless the R4 option below is adopted.

## 3. Code changes owed (`packages/extractor/src/router-provider.ts`)

**A5a — align the declared default** (line 312): registration declares
`defaultMaxTokens: 4096` for `txconv_statement_parse`; the router ≥ 0.0.5 floors it to
32768 so this is cosmetic, but update to `32768` so the declaration matches reality.

**A5b — truthful truncation error** (line 113): the error message reports the *requested*
cap (32000); report the actually-served cap from the response (`finishReason === 'length'`
plus `usage.completionTokens`) so a future clamp misdirects nobody.

**Hygiene**: replace the local `completeJson` re-implementation (lines 94-140) with SDK
`client.completeJson` — byte-for-byte equivalent today, drift hazard tomorrow.

**Optional (R4) — route page OCR through the router** (router ≥ 0.0.6): the
`glm-ocr-client.ts` calls are plain OpenAI chat completions against llama-server — the
exact shape the router's `local_ocr` kind serves. If adopted: register a
`txconv_page_ocr` class (local_only, vision), bind it to `glm/GLM-OCR`, and send pages as
`image_url` data-URI parts through the SDK; delete the bespoke OCR HTTP client's transport
(keep its caching/diagnostics layers). Gains: ledger visibility per page batch, console
model switching, router health/fallback machinery. Keep direct as the non-router mode.
*Effort M — separate ticket; ADR update required (supersedes part of ADR-025).*

## 4. Verification (universal gate + TxConvertor-specific)

1. **The regression that motivated 0.0.5:** convert a real multi-page statement in router
   mode → the full transaction array returns, `finishReason` is `stop` (never `length`),
   and the ledger shows completion tokens well above 4096.
2. Enrichment + check-resolve passes land under their classes.
3. Check-image OCR: page reads stay direct (unless R4 adopted — then they appear in the
   ledger under `local_ocr` at cost 0).
4. Fail-closed: unknown feature key in the app throws before any wire traffic (existing
   behavior — spot-check).
