# Runbook — myBooks

**Identity `vibe-mybooks` · vendored SDK 0.2.0 (in-tree copy; re-vendor to 0.2.3) · dual-mode · shipped MIG-2 (Q-069)**

**Revised 2026-09-04 for router 0.0.25.** Wire-compatible. What changed for this app in
0.0.25: `glm/GLM-OCR` can no longer be bound to any myBooks class without a deliberate
override (Q-097), the router now verifies every forced-JSON response itself and returns
`invalid_response` where the app used to see a truncated or empty body, the SDK union
carries every code the router sends (0.2.3), and Claude/GPT models served by DigitalOcean
must be acknowledged before a policy can bind them (Q-098, Q-100). Sections 1, 3 and 4 are
rewritten; section 2 is unchanged apart from one note.

## 1. Appliance provisioning

Shared P1–P8 from the README. App-specifics:

- **Models needed (P2/P3):** a local `json_schema` chat model, and **a local VISION model
  that also honours structured output** — an Ollama vision model (`llama3.2-vision:11b`,
  `qwen2.5-vl`, or similar) on the `local` provider. **Not `glm/GLM-OCR`:** since 0.0.25 the
  `local_ocr` kind is capped to transcription — `json_schema` and `tools` are false for every
  `local_ocr` row whatever the catalog says (`KIND_CAPABILITY_CEILING`, Q-097) — and all four
  myBooks vision classes register `requires: { json_schema: true, vision: true }`
  (`vibe-router.provider.ts:232-236`). The policy editor will not offer GLM-OCR for them.
  Without a local vision model that advertises `json_schema`, the four vision policies cannot
  be saved.
- **Token (P5):** identity `vibe-mybooks`.
- **Policy rows (P7):** eight classes. Note `mybooks_doc_classify` is a vision class — the
  original runbook listed it as text-only; the code registers it with `vision: true`.

| Class | Tier as registered | Requires | Bind to (local-first deployment) | Bind to (DigitalOcean, §1.2) |
| --- | --- | --- | --- | --- |
| `mybooks_txn_categorize` | local_only (seeded) | json_schema | local qwen3 | `deepseek-v4-pro` |
| `mybooks_receipt_extract` | cloud_deidentified (seeded) | json_schema+vision | local vision model | `glm-5.3-flash` |
| `mybooks_bill_extract` | local_only (registered) | json_schema+**vision** | local vision model | `glm-5.3-flash` |
| `mybooks_doc_classify` | local_only (registered) | json_schema+**vision** | local vision model | `glm-5.3-flash` |
| `mybooks_statement_extract` | local_only (registered) | json_schema+**vision** | local vision model | `kimi-k2.6` |
| `mybooks_vendor_enrich` | local_only (registered) | json_schema | local qwen3 | `deepseek-v4-pro` |
| `mybooks_chat` | local_only (registered) | — | local chat model | `deepseek-v4-pro` |
| `mybooks_report_narrative` | local_only (registered) | — | local chat model | `deepseek-v4-pro` |

Two deployment shapes. **Local-first** keeps the registered tiers and needs an on-box vision
model. **DigitalOcean** (§1.2) widens all eight to `cloud_deidentified` and binds
DigitalOcean-hosted open-weight models; it needs no local model at all.

### 1.1 Cloud vision for `mybooks_receipt_extract` (0.0.25 catalog)

If the firm widens receipts to a cloud model, the curated DigitalOcean entries now carry
real capabilities and pricing: `digitalocean/glm-5.3-flash` (vision, 1,048,576 ctx,
$0.15/$0.50 per MTok) is the DO-hosted open-weight option. `digitalocean/kimi-k2.6` and
`kimi-k2.5` remain curated with vision.

**Third-party-hosted models on DO** — `anthropic-claude-*` and `openai-gpt-*` ids discovered
from DO's `/models` — now carry a `3rd-party hosted` chip and a dated retention note in the
catalog (Q-098; Claude Fable: mandatory 30-day retention of prompts and completions; OpenAI
on DO serverless: no zero-data-retention). Binding one to a myBooks class requires naming it
in `acknowledgedModels` on `PUT /admin-api/policies/:key`; the UI asks, `savePolicy` refuses
without it, and the acknowledgement is persisted on the policy (Q-100) so it is not re-asked.
A pre-0008 policy export that binds one is refused on import until acknowledged. Whether a
receipt image may go to Anthropic-via-DigitalOcean at all is a WISP question, not a router
one — the router only makes the choice visible.

Reminder that has not changed: the scrubber rewrites **text** parts only. Receipt page images
on a cloud-bound class egress unscrubbed (Q-087). myBooks' own PII levels (strict / standard
/ permissive) sit on top of router policy and still decide whether pixels or sanitized text
leave the app in the first place.

### 1.2 DigitalOcean binding — replacing direct Claude Sonnet 4.5 (decided 2026-09-04)

**Decision.** myBooks today calls Claude Sonnet 4.5 directly for every AI task. The router
binding replaces that with DigitalOcean-hosted open-weight models on all eight classes, all
widened to `cloud_deidentified`. Chains are DigitalOcean open-weight only — no Anthropic or
OpenAI model served through DigitalOcean, and no local fallback (this deployment runs no
local model). Every task therefore has exactly one subprocessor under one DPA, with
DigitalOcean's no-storage, no-training, never-forwarded-to-the-model-creator terms.

**How the defaults were chosen** (revised 2026-09-04 against DO's current catalog and
pricing page, "last verified 1 Sep 2026"). "Most comparable to Sonnet 4.5" on published
benchmarks and on the shape of the work, then execution (latency, context, cost):

- **`deepseek-v4-pro-0813`** is the GA release (2026-08-13) that replaces the V4 Pro
  preview and the closest text-model peer to Sonnet 4.5: the preview already led it on
  MMLU-Pro (87.5 vs 86.0), GPQA (90.1 vs 83.4) and SWE-bench (80.6 vs 77.2), and 0813 beats
  the preview on every listed benchmark. 1M context, prompt caching, $1.32/$3.96 per MTok
  against Sonnet's $3/$15. Default for the four text classes. The preview
  (`deepseek-v4-pro`, now $0.87/$1.74) is a defensible cheaper default for categorization
  if cost outranks staying on the GA line — the 0813 gains are in agentic loops, not
  classification.
- **`glm-5.3-flash`** is the document-vision peer: DocVQA 94.6, OCRBench 91.2, image input
  and structured outputs both documented by DO, 1M context, $0.15/$0.50. Receipts, bills
  and page classification are short documents where OCR fidelity matters more than
  reasoning depth. Default for three of the four vision classes.
- **`qwen3.8-max`** is the closest thing on DO to Sonnet 4.5 as a vision-plus-reasoning
  model: DO documents text, image and video input, structured outputs and tool calling;
  GPQA 92.6; reported best object-detection VLM; 1M context; $2/$6, 40% of Sonnet's output
  price. Bank statements are long, dense and reconciled against a golden rule, so reasoning
  over tables beats raw OCR there. Default for `mybooks_statement_extract`; first vision
  fallback elsewhere.
- **`kimi-k3`** (2026-07-16) is the strongest open model on DO — Artificial Analysis index
  57, GPQA 93.5, MMMU-Pro 81.6, native vision, leads OmniDocBench — but its output price
  ($14.25) equals Sonnet's, DO publishes no context window for it, and it is
  **enrich-only in the curated catalog**: the row exists only after
  `POST /admin-api/providers/:id/discover-models`. The accuracy-first fallback, never a
  default.
- **`kimi-k2.6`** has strong published numbers (GPQA 90.5; beats Sonnet 4.6 on five
  benchmarks) and is the first **text** fallback. It is the **last** vision fallback because
  DO's models page, as of 2026-09-04, no longer states a modality for K2.6 or K2.5; the
  Router's catalog still carries `vision` from an earlier read. Run
  `POST /admin-api/models/:id/probe` before relying on it for images.
- **`qwen3.5-397b-a17b`** (MMLU-Pro 87.8, IFEval 92.6, 131K ctx) is the second text
  fallback. **`deepseek-v4-flash-0731`** (GA, $0.08/$0.25) is the cheap tail for the three
  high-volume text classes; **`glm-5.3`** is the tail for report narration, where prose
  quality matters more than cost.

Not chosen: `nemotron-3-ultra-550b` (loses to DeepSeek V4 Pro on 7 of 8 shared
benchmarks), `gemma-4-31B-it`, `mimo-v2.5-pro`, `minimax-m2.5`, `nvidia-nemotron-3-super-120b`
(public preview) — none reach Sonnet 4.5 territory.

**Assignments** — default, then fallbacks best → least:

| Class | Default | Fallback 1 | Fallback 2 | Fallback 3 |
| --- | --- | --- | --- | --- |
| `mybooks_txn_categorize` | `deepseek-v4-pro-0813` | `kimi-k2.6` | `qwen3.5-397b-a17b` | `deepseek-v4-flash-0731` |
| `mybooks_receipt_extract` | `glm-5.3-flash` | `qwen3.8-max` | `kimi-k3` | `kimi-k2.6` |
| `mybooks_bill_extract` | `glm-5.3-flash` | `qwen3.8-max` | `kimi-k3` | `kimi-k2.6` |
| `mybooks_doc_classify` | `glm-5.3-flash` | `qwen3.8-max` | `kimi-k3` | `kimi-k2.6` |
| `mybooks_statement_extract` | `qwen3.8-max` | `kimi-k3` | `glm-5.3-flash` | `kimi-k2.6` |
| `mybooks_vendor_enrich` | `deepseek-v4-pro-0813` | `kimi-k2.6` | `qwen3.5-397b-a17b` | `deepseek-v4-flash-0731` |
| `mybooks_chat` | `deepseek-v4-pro-0813` | `kimi-k2.6` | `qwen3.5-397b-a17b` | `deepseek-v4-flash-0731` |
| `mybooks_report_narrative` | `deepseek-v4-pro-0813` | `kimi-k2.6` | `qwen3.5-397b-a17b` | `glm-5.3` |

All ids are `digitalocean/<name>`. The vision classes can only chain among DO models that
carry `vision` in the catalog — `glm-5.3-flash`, `qwen3.8-max`, `kimi-k3`, `kimi-k2.6`,
`kimi-k2.5`. Save-time gating rejects anything else. The curated catalog was refreshed on
2026-09-04 for this binding: `qwen3.8-max` gained its documented `vision` flag, the DeepSeek
V4 preview rows took DO's current prices and 1M context, and the two GA DeepSeek ids were
added, so all of the above exist after the nightly sync without hand-editing.

**Apply.** The full set is in [`mybooks.digitalocean-policies.json`](mybooks.digitalocean-policies.json),
shaped for `POST /admin-api/policies/import`. Order matters:

1. DigitalOcean provider added and credentialed (shared P4); then
   `POST /admin-api/providers/:id/discover-models`. This is what creates the `kimi-k3` row
   and lets the nightly sync enrich the curated ids in place. Import refuses any id that is
   "not in catalog".
2. Optional but recommended: `POST /admin-api/models/:id/probe {"apply":true}` on
   `glm-5.3-flash` and `kimi-k2.6` to confirm vision against the firm's own key. Curated
   rows already carry `vision`, so gating passes without it; the probe is verification.
3. Boot myBooks once in router mode so the eight classes register (`local_only`).
4. Widen each class: `PATCH /admin-api/task-classes/<key> {"sensitivity":"cloud_deidentified"}`
   × 8. **Import never relaxes sensitivity** — a `local_only` class rejects every DO model at
   import with "local_only class requires a local model". The `sensitivity` values in the
   JSON document intent; they do not perform the widening.
5. `POST /admin-api/policies/import` with the file. Expect eight policies created; no
   acknowledgement prompts, because no third-party-hosted model is bound.
6. Cut the app over: `VIBE_AI_MODE=router` and remove the direct Anthropic key from
   myBooks' configuration once verification (§4) passes. Keep direct mode available as the
   non-router deployment path only.

**What changes for the firm.** Every task's images and text now go to DigitalOcean instead
of Anthropic. The scrubber still rewrites text parts on the way out; images still pass
through unscrubbed (Q-087). Name DigitalOcean, not Anthropic, as the AI service provider
in the WISP for myBooks, and record that Claude/GPT-on-DigitalOcean is excluded.

### 1.3 Upgrading a 0.0.24 appliance that had GLM-OCR bound

A 0.0.24 policy that bound a `local_ocr` row to `mybooks_bill_extract`, `mybooks_doc_classify`
or `mybooks_statement_extract` fails **`capability_missing` on every request** after the
upgrade until rebound. The boot-time policy health scan audits each such binding as
`policy_binding_invalid` and logs it; the Policies page shows the class as unsatisfiable.
Rebind to a local vision model. Do **not** reach for the per-model `json_schema` override on
GLM-OCR unless the OCR server genuinely honours grammar constraints — llama-server will
otherwise force a 0.9B model to emit JSON it cannot ground.

## 2. App configuration

```
VIBE_AI_MODE=router
VIBE_AI_ROUTER_URL=http://vibe-ai-router:8220
VIBE_AI_TOKEN=<minted vibe-mybooks token>
```

Router mode short-circuits `executeWithFallback` (`ai-providers/index.ts:194-196`) — the
router owns fallback. Boot registration retries with backoff.

Router-side knob worth knowing: `ROUTER_SCHEMA_VALIDATION` (`structural` default | `strict`)
sets how strictly forced-JSON responses are checked against an app-supplied schema. myBooks
sends `responseFormat: { type: 'json_object' }` only (`vibe-router.provider.ts:127`), never a
schema, so the `enum`-softening in 0.0.25 does not affect it either way.

## 3. Code changes owed

**A2 — preserve the router error taxonomy** (`packages/api/src/services/ai-providers/vibe-router.provider.ts:145-146`). **Still open as of 2026-09-04.**
Every `VibeAiError` is re-wrapped into `new Error(message)`, so `retryWithBackoff`
(`utils/retry.ts:92-95`, driven from `ai-providers/index.ts:159`) keys on HTTP status it can
no longer see: it retries non-retryable 4xx (`policy_blocked`, `auth_error`,
`budget_exceeded`) and never honors `Retry-After`.

Fix, updated for SDK 0.2.3:

1. **Re-vendor the SDK.** `vibe-ai-client.ts` is an in-tree copy of `sdk-v0.2.0`
   (its header says so). Replace it with `packages/sdk` at `sdk-v0.2.3`. The 0.2.3 union is
   derived from a runtime `VIBE_AI_ERROR_CODES` array and is tested to be a superset of the
   router's codes; 0.2.0 lacks `invalid_response` and `no_vision_provider`, both of which the
   router has sent since 0.0.24 and which today fall through the app's error handling as
   plain messages.
2. Rethrow the original `VibeAiError` (or a wrapper carrying `.code`, `.status`,
   `.retryAfterSeconds`, `.retryable`, `.detail`) and gate `retryWithBackoff` on
   `err.retryable === true`, using `retryAfterSeconds` as the first delay.
3. Handle the two codes the router adds at request time:
   - `invalid_response` (502): the router already verified the body, retried the same model,
     and walked the fallback chain. Use the SDK's `isInvalidResponse(err)` guard and branch
     on `err.detail.reason`: `json_truncated` → raise the class's `defaultMaxTokens` or the
     policy's `maxTokensOverride` (statement extraction is the one at risk — it already
     registers 16384); `response_not_json` / `empty_response` → surface as a provider fault.
     Do not loop on it. The SDK marks it `retryable`; myBooks should treat one retry as the
     ceiling, because the router has already retried.
   - `no_vision_provider` (409): the vision class is bound to nothing that advertises
     vision — after a 0.0.25 upgrade, usually a GLM-OCR binding (§1.3). Surface an admin-
     facing message; do not retry.
4. **Truncation handling moves upstream.** `extractJsonForResult(text, format, { truncated })`
   (`vibe-router.provider.ts:136`) expects to see a truncated body. Against 0.0.25 it mostly
   will not: the router catches `finish_reason: 'length'` on a forced-JSON request and returns
   `invalid_response` / `json_truncated` instead of the partial body. Keep the app-side path
   for direct mode; in router mode expect the error, not the flag.

*Effort S → S+ with the re-vendor.*

**R4, reshaped — route the local OCR paths through the router.** The original proposal
("page images to `glm/GLM-OCR` under `mybooks_statement_extract` / `mybooks_bill_extract`")
is **not possible on 0.0.25 as those classes are declared**: both require `json_schema`, and
the `local_ocr` kind no longer advertises it. Two options:

- **(a) Keep GLM-OCR direct.** This is router decision D5 ("GLM-OCR stays direct") and what
  the app does today: `glm-ocr.client.ts` posts one page per call to the llama-server at
  `GLM_OCR_BASE_URL`, takes text back, and the extraction LLM runs on text. No router change,
  no ledger row for the OCR leg. Acceptable; the OCR leg is on-box either way.
- **(b) Add a transcription-only class.** Register `mybooks_page_ocr` with
  `requires: { vision: true }` and nothing else, `local_only`, bound to `glm/GLM-OCR`. Point
  `glm-ocr.client.ts` at the SDK with a vision content part
  (`{type:'image_url', image_url:{url:'data:image/png;base64,…'}}`) and the same `OCR:` /
  `Text Recognition:` prompt; keep the text-then-JSON shape exactly as it is, with the JSON
  leg still under `mybooks_statement_extract` / `mybooks_bill_extract`. That gives ledger
  visibility, console-switchable OCR models, and the circuit breaker moves to the router.
  Drop the `forceDirect` flags on the OCR call sites only (`ai-config.service.ts:414,491`
  are admin credential tests and stay direct; `qwen-client.service.ts:90,153` is the pinned
  qwen pipeline, a separate decision).

Option (b) is the router-native shape and is the one that would let the router's proposed
preprocess stage (R5, decision D7 still open) replace it later with zero app change. *Effort
M — do after A2.* Keep direct mode as the non-router deployment path regardless.

## 4. Verification (universal gate + myBooks-specific)

1. Categorize a bank feed batch → ledger rows for `mybooks_txn_categorize` at cost 0.
2. Receipt upload → `mybooks_receipt_extract`; cloud-bound path shows scrub events for a
   fixture containing a card number (Luhn-valid). If the class is bound to a `3rd-party
   hosted` DO model, the policy row shows it acknowledged, not the red "unacknowledged" chip.
3. Post-A2: disable a class's policy → the app surfaces the error immediately (no backoff
   retry storm in its logs); a router 429 is retried after the advertised delay; a forced
   truncation (set `maxTokensOverride: 64` on `mybooks_statement_extract`, upload a
   statement) surfaces as `invalid_response` / `json_truncated` in the app, not as a silently
   partial statement, and the router ledger shows the request with that status.
4. Vision classes: bill, doc-classify and statement extraction complete against the bound
   local vision model. If the appliance was upgraded from 0.0.24 with GLM-OCR bound, the boot
   log shows no `policy_binding_invalid` for `mybooks_*` after rebinding.
5. If R4(b) is adopted: the OCR leg appears in the ledger under `mybooks_page_ocr` /
   `local_ocr` at cost 0, one row per page, and the JSON leg under the extract class.
6. App-side consent + per-company toggles still gate features (they sit on top of router
   policy, not instead of it).
