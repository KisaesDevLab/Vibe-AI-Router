# Plan — Router changes raised by Vibe 1040's DigitalOcean binding

| | |
| --- | --- |
| **Status** | **Applied 2026-09-03** in router 0.0.25 / SDK 0.2.3 — A–E as code (see CHANGELOG 0.0.25, Q-097, Q-098; deviations from the text below: D is enforced in `effectiveCapabilities()` because the adapter's `capabilities()` has no callers; E's regex excludes DO's own open-weight `openai-gpt-oss-*`; E's OpenAI retention note quotes DO's page as read 2026-09-03, which differs from the claim in E; `invalid_response` stays `retryable` in the SDK with softened doc wording). F and G applied as ticket text. Originally raised by Vibe 1040, 2026-09-03, against router v0.0.24 |
| **Raised by** | Vibe 1040 v0.0.3/v0.0.4 (see that repo's STATE.md decision log, 2026-09-02) |
| **Scope** | Seven items. Four are small and independent (A–D); one is a data change (E); two are existing tickets with new information (F, G) |
| **Total estimate** | A–E: **~1.5 d** combined. F and G are already estimated in their own tickets |

## Context

Vibe 1040 bound its three task classes to DigitalOcean-hosted open-source models
(`digitalocean/glm-5.3-flash` for vision, `digitalocean/qwen3.5-397b-a17b` for text) and
worked through what the app has to handle against this router. Everything app-side shipped.
What follows is what the router should change so the next appliance does not rediscover it.
Nothing here is blocking Vibe 1040; items A and B would have prevented real bugs there.

Recommended order: A, B, C together (one PR, one SDK minor); D and E as data/config PRs; F
and G stay on their own schedule.

---

## A. Publish the SDK that carries the codes the router already sends — **S, 0.5 h**

**Problem.** `src/gateway/errors.ts:20,25` emit `no_vision_provider` and `invalid_response`.
`packages/sdk/src/index.ts:12-27` lists both in `VibeAiErrorCode`. But `packages/sdk/package.json`
still says `0.2.2`, the same version consumers vendored before those codes were added, so an
app that pinned `0.2.2` can have a dist whose union lacks them and never know. Vibe 1040 did:
its installed `dist/index.d.ts` under `0.2.2` has neither code, its `classifyFailure` sent
both to the `default` branch, and a `json_truncated` page would have parked forever.

**Change.**
1. Bump `packages/sdk/package.json` to `0.2.3`. Any change to `VibeAiErrorCode` is a public
   type change and needs a version bump even when the wire is additive.
2. `packages/sdk/CHANGELOG.md`: entry for 0.2.3 naming the two codes and pointing at
   `detail.reason` for `invalid_response`.
3. Export the reason union so apps can branch on it without string literals:
   `export type InvalidResponseReason = 'empty_response' | 'provider_error_finish' | 'tool_arguments_not_json' | 'response_not_json' | 'json_truncated' | 'schema_violation'`
   (mirror of `src/gateway/verify.ts:24-31`), and type `VibeAiError.detail` for that code.
4. Add a unit test in `packages/sdk` that asserts the SDK union is a superset of the
   router's `ERROR_CODES` array in `src/gateway/errors.ts`, so the two cannot drift again.

**Consumers.** Vibe 1040 re-vendors on its next release; its `classifyFailure` already
widens the code to `string`, so nothing breaks either way.

---

## B. Document `invalid_response` and `no_vision_provider` in the frozen contract — **S, 1 h**

**Problem.** `docs/integration.md:52-62` is the frozen contract and its error table lists
neither code. The router has sent both since 0.0.24 (CHANGELOG.md:57, :111). An app written
from the contract cannot handle them.

**Change.** Two rows in the table, additive (semver-minor per §12.8):

| code | what your app should do |
| --- | --- |
| `invalid_response` | The router validated the response against your `json_schema` (or found it empty/non-JSON), retried the same model, walked the fallback chain, and gave up. **Permanent** — do not park or retry. `detail.reason` is one of `json_truncated`, `schema_violation`, `response_not_json`, `empty_response`, `provider_error_finish`, `tool_arguments_not_json`; `detail.path` is the schema path for a violation. For `json_truncated`, raise the class's `max_tokens` or ask for less |
| `no_vision_provider` | The class requires `vision` and no bound model advertises it — usually a discovered model that was never probed. Park; an admin fixes it with `POST /admin-api/models/:id/probe`. HTTP 409 |

Also note under `output_truncated` that with forced JSON the router usually catches the
truncation first and returns `invalid_response`/`json_truncated`, so apps should handle both.

---

## C. Do not enforce `enum` on forced-JSON responses by default — **S, 0.5 d**

**Problem.** `src/gateway/verify.ts` enforces `enum`, `required`, `type`, and `items` from
the app's schema. Vibe 1040's binder used `field_key: { enum: [...40 keys] }`; one invented
key from a 397B model fails the whole response, costs a router retry and a fallback walk, and
then surfaces as permanent `invalid_response`. The app's own code was already dropping
unknown keys. The app removed the `enum` to work around this, which throws away a real
constraint the model would otherwise honour.

**Change.** Make `enum` violations a *soft* finding: log, count in the ledger as
`schema_enum_miss`, and pass the response through. Keep `required`/`type`/`items` hard —
those break parsing. Alternatively add `responseFormat.validation: 'structural' | 'strict'`
(default `structural`) to the envelope; `strict` restores today's behaviour. Prefer the flag:
it is additive, and an app that wants the router to reject enum misses can ask for it.

**Where.** `src/gateway/verify.ts` (subset validator), `src/gateway/envelope.ts` (flag),
`docs/envelope.md`, `docs/integration.md` (one line), SDK `RequestOptions.responseFormat`.

---

## D. Stop `local_ocr` models from being bindable to geometry-shaped classes — **S, 0.5 d**

**Problem.** `src/adapters/openai-compat/index.ts:34-43` advertises `jsonSchema: true` and
`vision: true` for every kind including `local_ocr`. GLM-OCR via llama-server returns text
and Markdown tables; it has no geometry. Binding a class like Vibe 1040's `v1040_layout`
(vision + json_schema, asks for bounding boxes) to it passes config-time gating, and
llama-server's grammar constraint then forces a 0.9B OCR model to invent a spans array.
Vibe 1040 records this as QUESTIONS.md Q14 and CLAUDE.md §4.

**Change.** Give `local_ocr` its own `capabilities()`: `vision: true`, `jsonSchema: false`,
`tools: false`, `streaming: false`. Operators who know their OCR server honours grammar
constraints can re-enable `json_schema` per model via `capability_overrides` (existing
mechanism, Q-062). Config-time gating then refuses a `json_schema` class for GLM-OCR with the
existing "why is this model hidden" hint. Add one policy-editor hint line: "`local_ocr`
models transcribe; they do not emit structured output or coordinates."

---

## E. Curate the DigitalOcean models Vibe 1040 uses, and mark third-party-hosted ones — **S, 2 h (data)**

**Problem 1.** `data/digitalocean-models.json` (retrieved 2026-07-29) has no
`glm-5.3-flash`, `glm-5.3`, or `qwen3.8-max`. They arrive by discovery with `json_schema`
only, an 8192 context placeholder, no pricing, and no `vision` until an operator probes.
Vibe 1040's runbook now tells operators to probe and to hand-edit the context window.

**Change.** Add curated entries:

| id | ctx | vision | json_schema | notes |
| --- | --- | --- | --- | --- |
| `digitalocean/glm-5.3-flash` | 1,048,576 | yes | yes | DO docs: text, image, video; structured outputs ✔ |
| `digitalocean/glm-5.3` | 1,048,576 | no | yes | structured outputs ✔ |
| `digitalocean/qwen3.8-max` | 1,048,576 | yes (verify by probe) | yes | DO docs list image input on one page only — mark `vision` conservative and let the probe decide |

Pricing from docs.digitalocean.com/products/inference/details/pricing at time of edit; if
absent, leave the entry ENRICH-ONLY per Q-088. Existing `qwen3.5-397b-a17b` is fine.

**Problem 2.** DO's `GET /models` also lists `anthropic-claude-*` and `openai-gpt-*`.
Discovery inserts them as ordinary `digitalocean/…` rows with `json_schema: true`, so an
operator can bind a `cloud_deidentified` class to Claude-on-DO without seeing that DO's
terms differ: Anthropic applies zero retention **except** Claude Fable, which carries a
mandatory 30-day retention, and OpenAI-on-DO serverless has no zero-data-retention at all
(DO data-privacy page, verified 2026-09-01). The curated file deliberately excludes them
(Q-061) but discovery re-admits them silently.

**Change.** In `src/catalog/discovery.ts` (`planDiscovery`), tag discovered DO ids matching
`/^(anthropic|openai)-/` with `third_party_hosted: true` and a short `retention_note`
(text from the DO page, dated). Policy editor shows the note next to the model and requires
an explicit confirm to bind it. Do not filter them out — a firm may legitimately want Claude
on DO for a class whose WISP names Anthropic. The point is that it is a visible choice.

---

## F. R6 region pinning — new information for the design — **already ticketed, M**

`docs/ticket-R6-region-pinning.md` proposes `providers.region` declared by the operator
and `policies.requiredRegionPrefix`. Two facts from the DO binding that the design should
absorb:

1. **DigitalOcean serverless inference has no region.** DO publishes no region selection
   and no statement stronger than "runs entirely within DigitalOcean's infrastructure."
   Only dedicated inference is region-addressable (NYC, SFO, ATL, RIC, MKC, MEM). So a
   `digitalocean` serverless provider's `region` must be allowed to be `unknown`, and a
   class with `requiredRegionPrefix: 'us'` must **fail closed** against it — `policy_blocked`,
   never substituted around. That is the invariant R6 already states; this is the first
   provider that will hit it in practice.
2. **Vibe 1040 is running with its region assertion disabled by recorded decision** (its
   QUESTIONS.md Q13), not because R6 is missing but because there would be nothing for R6 to
   assert against on DO serverless. R6 therefore unblocks Vibe 1040 P14 only when paired
   with a region-declared provider (local, or DO dedicated). Say so in the ticket so R6 is
   not mistaken for the whole fix.

Also: fold `GET /v1/policy/regions` into a general **`GET /v1/policy/effective`** that
returns, for the caller's registered classes, `{ key, sensitivity, defaultModel, allowedModels,
regions }`. Today an app can learn its tier only by re-registering (`registration.ts:65-98`)
and can never learn the bound model except from `served.model` after the fact. Vibe 1040
wanted this for its startup assertion and for its accuracy harness. Additive, S on top of R6.

---

## G. R5 preprocess stage — new information for decision D7 — **already ticketed, M**

`docs/router-option-addendum.md:158` leaves D7 open. From the Vibe 1040 work:

- The compliance case for R5 is stronger than the ticket states. Vibe 1040's WISP amendment
  now has to say in plain words that full W-2 and 1099 page images with SSNs leave the
  premises for every cloud-bound class. R5 as specified (local OCR → scrubbed text → cloud)
  removes that sentence entirely for text-shaped classes.
- R5 as specified does **not** help geometry-shaped classes. A preprocess stage that
  returns only text cannot feed a class that needs bounding boxes; Vibe 1040 would still
  send pixels for its layout pass. If R5 is built, consider an `hocr`-style output mode
  (word boxes from the local OCR engine, e.g. Tesseract TSV or PaddleOCR-VL layout output)
  passed to the app alongside the text. That is the one addition that would let Vibe 1040
  drop image egress completely. Scope it as R5b, not as part of D7.
- Vibe 1040 chose VLM geometry on DO for v1 knowing this; the sidecar-geometry redesign is
  its documented fallback. It will move to R5/R5b if they ship.

---

## Verification

- A: `npm test` in `packages/sdk` includes the superset assertion; Vibe 1040 re-vendors
  0.2.3 and its `test/router.test.ts` passes unchanged.
- B: `docs/integration.md` diff is additive only; CHANGELOG notes the contract addition.
- C: a fixture forced-JSON response with one enum miss passes through with a ledger
  `schema_enum_miss` count (or is rejected when `validation: 'strict'`); the existing
  schema-violation tests for `required`/`type` still reject.
- D: policy editor hides `glm/GLM-OCR` for a class requiring `json_schema` and shows the
  hint; enabling the override per model re-admits it.
- E: nightly sync enriches an existing discovered `glm-5.3-flash` row in place (Q-088);
  a fresh discovery of a DO provider shows the Anthropic/OpenAI rows with the retention
  note and the confirm gate.
- F/G: ticket text updated; no code.
