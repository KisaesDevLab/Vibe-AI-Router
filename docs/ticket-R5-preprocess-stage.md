# R5 — Preprocess stage: local OCR before scrub

| | |
| --- | --- |
| **Status** | Proposed — awaiting operator decision **D7** |
| **Estimate** | **M** — 3–4 d router-side, 0 d app-side |
| **Depends on** | R4 / Q-075 (`local_ocr` provider kind) — shipped 0.0.6 |
| **Supersedes** | The accepted-exposure caveat in Q-086/Q-087; makes the two-call OCR pattern in `docs/integration-plans/transaction-convertor.md` §R4 unnecessary |
| **Touches an invariant** | Yes — invariant 8 (one ledger row per request). See §5. |

## 1. Problem

Two problems, one mechanism.

**1a. Image parts are unscrubbable, and we currently ship that as accepted risk.**
`src/protect/scrub.ts:225` maps content parts and rewrites `type === 'text'` only — image
parts are copied through verbatim. Every `cloud_deidentified` class that declares
`vision: true` therefore egresses page images to a cloud provider with no scrubbing:

| Task class | Sensitivity | What leaves the box |
| --- | --- | --- |
| `tb_doc_extract` | cloud_deidentified | Client document page images |
| `mybooks_receipt_extract` | cloud_deidentified | Receipt scans |
| `timebill_file_naming` | cloud_deidentified | First pages of uploaded documents |

Q-087 records the decision explicitly: *"the scrubber redacts text parts only, so document
page images reach the cloud model unscrubbed — Kurt accepted this exposure (parallels
`mybooks_receipt_extract`)."* The scrubber cannot read pixels, so no amount of work on the
scrubber closes this. The only fix is to stop sending pixels.

*Added 2026-09-03 (Vibe 1040 v0.0.3/0.0.4, item G):* the compliance case is stronger than
the paragraph above states. Vibe 1040 bound its classes to DigitalOcean and its **WISP
amendment now has to say, in plain words, that full W-2 and 1099 page images containing
SSNs leave the premises for every cloud-bound class.** R5 as specified (local OCR →
scrubbed text → cloud) removes that sentence entirely for text-shaped classes. That is a
sentence a firm's engagement letter and §7216 posture have to carry until R5 ships; it is
not a quality preference.

**1b. `local_only` vision classes are stuck with a general vision model.**
`mybooks_bill_extract`, `mybooks_statement_extract`, `mybooks_doc_classify`, and
`v1099_w9_extract` can never reach a cloud adapter (invariant 5), so the field is Ollama
`llama3.2-vision:11b` vs. `glm/GLM-OCR`. For dense tabular documents a dedicated OCR pass
feeding a strong text model beats a general 11b vision model on table fidelity. Apps that
want that today must build it themselves — two task classes, two round trips, per-app glue
(the pattern sketched for `txconv_page_ocr`).

## 2. Non-goals

- **Generic model chaining.** This is one optional, local-tier, image→text stage. It is not a
  DAG, not a workflow engine, and not user-scriptable.
- **Cloud preprocessors.** A cloud preprocess model is a config error, refused at save time
  and again at request time. The entire compliance argument depends on OCR happening on-box.
- **De-tokenization / reversibility.** Same as the scrubber: one-way, no mapping table.
- **Geometry.** R5 returns text. A class that needs bounding boxes (Vibe 1040's
  `v1040_layout`) cannot be fed by it and would still send pixels. That is a real gap with
  its own scope — **R5b**, §12a — not a reason to widen R5.

## 3. Where the control lives: policy, not task class

The task class declares *what the work needs* (`requires.vision`). Whether pages are OCR'd
locally first is *how the firm chooses to handle it* — an operator control, and for the
`cloud_deidentified` classes a compliance control. Per invariant 6 it belongs on the policy
row, where an app cannot switch it off.

New columns on `policies` (migration `0005_policy_preprocess`, reversible; the `down` nulls
the columns and drops the FK):

```
preprocess_model_id     uuid null references models(id)   -- null = feature off
preprocess_mode         text null                         -- 'ocr' (only value in v1)
preprocess_keep_images  boolean not null default false    -- local_only may want both
preprocess_max_tokens   integer not null default 4096
preprocess_cache_ttl_s  integer not null default 3600
preprocess_on_error     text not null default 'block'     -- 'block' | 'passthrough'
```

Explicit columns rather than a jsonb blob, matching the existing policy knobs
(`max_tokens_override`, `temperature_min/max`) — `db/schema.ts:211`.

## 4. Pipeline placement

```
auth → resolve task class → policy → budget → PREPROCESS → scrub → route → adapt → ledger → respond
```

Before `scrub` — that is the whole point of §1a. After `budget` so a hard-stopped firm does
not spend cycles first (local cost is 0, but the ordering is free).

`stagePreprocess(ctx, deps, signal)` in `src/gateway/pipeline.ts`:

1. No-op when `policy.preprocessModelId` is null **or** the envelope carries zero image parts.
2. Resolve the preprocess model; hard-validate **local-tier** (`isLocalKind`) and
   vision-capable. Capability gating happens twice (invariant 7) — this is the request-time
   half; §7 covers the config-time half.
3. For each image part, one call through `routeForModel` + `adapter.execute` with a fixed OCR
   instruction and `preprocess_max_tokens`. Pages run sequentially in v1 — bounded concurrency
   is a follow-up, not a v1 risk worth taking against the shed guard.
4. Replace each image part with `{ type: 'text', text: '[page N transcription]\n' + ocr }`.
   Keep the image alongside when `preprocess_keep_images` is set.
5. Mutate `ctx.envelope` in place, then hand off to `stageScrub` — which now sees ordinary
   text and redacts it through the existing path.

Preprocess gets its **own** timeout, and the primary call's total-timeout clock starts after
it returns. A 12-page statement at ~2 s/page would otherwise blow the 120 s total budget —
the same lesson Q-077 taught for streams.

## 5. Ledger — the one invariant this ticket amends

Invariant 8 is "exactly one ledger row per request, idempotent by request ID" (`request_id`
is uniquely indexed; `src/ledger/writer.ts:93` relies on it for idempotency). Preprocess makes
two upstream calls under one request id. Two options:

**(a) Fold preprocess tokens into the single row.** Preserves the invariant verbatim, but
`model_served` then names one of two models that served the request, and per-stage cost
visibility is gone.

**(b) A second row, `stage = 'preprocess'`, keyed `${requestId}#pre`,** with new columns
`stage text not null default 'primary'` and `parent_request_id text null`. Invariant 8 is
restated as: *exactly one ledger row per upstream call, idempotent by ledger key; every
request has exactly one `stage='primary'` row.*

**Recommendation: (b).** Cost attribution stays honest and the Costs view can group by
parent. It requires an edit to `CLAUDE.md` §Core invariants and to the invariant test in
`/test/invariants` — **this is the part of the ticket that needs explicit sign-off, not just
implementation approval.** Local OCR costs 0, so the Costs view impact is presentational.

## 6. Audit

Two new events in the `src/protect/audit.ts` registry, zod-validated like the rest. Counts
only — the transcription is document text and must never reach `detail` (invariant 2):

```ts
preprocess_applied: z.object({ model: z.string(), images: z.number(),
                               chars_out: z.number(), ms: z.number() }),
preprocess_failed:  z.object({ model: z.string(), reason: z.string().max(300) }),
```

Confirm the pino redaction paths cover the new stage's log fields before merge.

## 7. Failure policy — fail closed

| Class sensitivity | OCR fails | Behavior |
| --- | --- | --- |
| `cloud_deidentified` / `cloud_allowed` | any reason | **Block.** `preprocess_on_error` is ignored — falling through would egress the raw image, which is the exact hole being closed (principle 3). |
| `local_only` | any reason | `preprocess_on_error`, default **`block`**. The image never leaves the box either way, so `passthrough` is a defensible operator choice; the default is still the restrictive one. |

Config-time validation in `src/policy/save.ts`:

- Preprocess model must be local-tier and vision-capable → else refuse.
- A policy whose default model lacks `vision` may only be saved for a `vision: true` class
  **when preprocess is enabled**; disabling preprocess re-validates and refuses with a clear
  error naming the models that would break. This is Risk 1 below, closed at both ends.

## 8. Caching

Reuse `ResponseCache` with a preprocess key shaped like `cache.ts:25`:
`firmId:preprocessModel:sha256(imageBytes):paramsDigest`, TTL `preprocess_cache_ttl_s`.
Page images repeat constantly across classify-then-extract passes over the same document —
this is where the latency and cycle savings actually come from.

## 9. Console

Policy editor gains a **Preprocess (local OCR)** section, shown only for classes whose task
class declares `vision: true`: model picker filtered to local-tier vision models, keep-images
toggle, on-error selector, TTL. **Off by default everywhere**, including in the curated pack —
`pickDefaultModel` is untouched.

## 10. Risks

1. **Silent capability widening.** Stripping images means `requestRequires()` no longer
   demands `vision`, so a text-only model becomes eligible for a class that declared it.
   Desirable (it frees the class from the vision pool) but it must not happen silently, and
   turning preprocess back off must not strand the policy. Closed by the two-way save-time
   validation in §7; both directions get a test.
2. **Quality regression vs. native vision.** OCR discards layout. A native vision model may
   well beat OCR+text on receipts — short, visual, layout-light — even where it loses on
   statements. Mitigation: opt-in per class, and **require a shadow-diff report per class**
   before enabling in production. The harness already exists.
3. **Invariant 8 amendment** (§5) — sign-off, not just review.
4. **Latency.** OCR is serial ahead of the primary call: roughly +1–3 s for a one-page
   receipt, proportionally worse for statements. Fine for batch extraction, wrong for
   interactive classes. Document it; do not enable on chat classes.
5. **Prompt-body leakage.** OCR output *is* document text. It rides the normal envelope
   (never persisted — invariant 2 holds), but audit detail, error messages, and log fields
   all need the usual grep check.

## 11. Scope

Router-side:

- Migration `0005_policy_preprocess` (reversible; down nulls columns and drops the FK)
- Policy schema + save-time validation (`src/policy/save.ts`, `src/policy/engine.ts`)
- `stagePreprocess` + runner wiring (`src/gateway/pipeline.ts`)
- Ledger stage rows + writer change (`src/ledger/writer.ts`) + invariant test + `CLAUDE.md`
- Two audit events (`src/protect/audit.ts`)
- Console policy-editor section
- Tests: unit (stage), integration (happy path + OCR-failure-blocks), invariants (cloud
  preprocessor refused, `local_only` unaffected), QA Round B fuzz over the new policy fields

**3–4 d.**

App-side: **none.** Apps keep sending image parts; the router transparently OCRs. The
`txconv_page_ocr` class proposed in the TxConvertor integration plan becomes unnecessary —
the app sends pages to `txconv_statement_parse` and the router does both halves. Fold that
delta into MIG-6 when it is scheduled.

## 12. Acceptance

1. **The test that justifies the ticket:** a `cloud_deidentified` vision class with preprocess
   on, sent a page image containing a client name → the cloud adapter receives **no image
   part** and a scrubber-redacted transcription; `scrubber_redacted` is audited with a nonzero
   count.
2. OCR failure on that same class → request blocked, and the cloud adapter is asserted never
   to have been invoked.
3. A `local_only` class with preprocess off is byte-identical to today.
4. Config-time: cloud preprocess model → refused. Text-only default on a `vision: true` class
   with preprocess off → refused. Disabling preprocess on a policy that relies on it →
   refused, with the offending models named.
5. Ledger: one `primary` row + one `preprocess` row, preprocess cost 0, both idempotent on
   replay of the same request id.
6. Zero-cloud appliance still boots and serves end to end (invariant 4).
7. `test/qa-round-b.test.ts` and `test/qa-round-d-security.test.ts` clean.

## 12a. R5b — geometry output mode (scoped separately; NOT part of D7)

*Added 2026-09-03 from the Vibe 1040 binding.* R5 as specified does **not** help
geometry-shaped classes. A preprocess stage that returns only text cannot feed a class that
needs bounding boxes; Vibe 1040 would still send W-2/1099 pixels for its layout pass
(`v1040_layout`: vision + json_schema, asks for spans with coordinates), so for that app R5
removes the WISP sentence in §1 for its text classes and leaves it standing for layout.

The one addition that would let Vibe 1040 drop image egress completely is an
**hOCR-style output mode**: the local OCR engine emits word boxes alongside the text
(Tesseract TSV, PaddleOCR-VL layout output, or GLM-OCR's own line geometry if its server
exposes it), and the router passes both to the cloud model — text scrubbed as in R5,
geometry as structured data that the scrubber can also see (a box is not PII; the word in
it was already redacted). The app then asks the cloud model to reason over
`{ text, words: [{ text, bbox }] }` instead of over pixels.

Scope notes, so this is sized honestly when it is scheduled:

- **Depends on R5** (same stage, same policy fields, same ledger row) plus an OCR engine
  that produces geometry. GLM-OCR via llama-server does not today (see Q-097: it
  transcribes, no coordinates), so R5b implies a second local OCR kind or a
  Tesseract/PaddleOCR sidecar on the appliance.
- **Contract:** a new envelope content part (`{ type: 'ocr_layout', text, words[] }`) or a
  system-message rendering of it — decide at design time; the former keeps invariant 9
  (one internal format) honest.
- **Not a substitute for a VLM's spatial judgment.** Word boxes give a text model where
  things are, not what a form looks like. Vibe 1040 should expect to re-validate its layout
  accuracy harness against it, which is why it is not folded into D7.
- **Estimate:** M on top of R5. Do not ship R5b before R5 has run on real documents.

## 13. Decision needed — D7

**Ship R5, or keep accepting the image-egress exposure recorded in Q-086/Q-087?**

Recommendation: **ship, scoped initially to the three `cloud_deidentified` vision classes.**
That is the half that changes a compliance posture rather than a quality number — it converts
an unscrubbable payload into a scrubbable one, which is the claim the §7216 story rests on.
The `local_only` quality win (§1b) is real but is a preference, and can follow once the
shadow-diff reports say OCR actually wins on those documents.

*2026-09-03:* Vibe 1040 chose VLM geometry on DigitalOcean for its v1 knowing all of the
above; its documented fallback is a sidecar-geometry redesign on its side. It will move to
R5 for its text classes and to R5b for layout if and when they ship — so D7 now has a
second consumer waiting on it, and R5b (§12a) has one. Neither changes the recommendation;
both change the cost of leaving D7 open.
