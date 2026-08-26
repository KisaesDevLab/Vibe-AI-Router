# Scrubber corpus & behavior (Phase 8)

Implementation: `src/protect/scrub.ts` (pure, deterministic — no ML, no network).
Test corpus: `test/scrub.test.ts`. Perf budget: <5 ms on 100 KB (median-of-7, test-enforced).

## Detectors

| Type | Trigger | Validation | Token |
| --- | --- | --- | --- |
| `ssn` | `NNN-NN-NNNN` / `NNN NN NNNN`; bare 9 digits only with `ssn\|social security\|taxpayer id\|itin` within the preceding 40 chars | area ≠ 000/666/9xx, group ≠ 00, serial ≠ 0000 | `[SSN]` |
| `ein` | `NN-NNNNNNN` | IRS campus prefix table (79 valid prefixes) | `[EIN]` |
| `routing` | 9 consecutive digits | ABA checksum (3-7-1 weights) AND Federal-Reserve prefix ranges (00–12, 21–32, 61–72, 80) | `[ROUTING]` |
| `account` | 6–17 digit run | within ±120 chars of a routing match OR `acct/account/iban/checking/savings` within preceding 30 chars | `[ACCOUNT]` |
| `card` | 13–19 digits incl. space/dash groups | Luhn AND IIN prefix (Visa/MC incl. 2-series/Amex/Discover) | `[CARD]` |

Precedence on overlapping spans: card → routing → ssn → ein → account (first claimant wins).

## Known lookalike negatives (tested)

Dates (`2026-07-26`), ZIP+4 (`64106-2145`), phone fragments (`555-0142`), invoice/order numbers
without keywords, 16-digit non-IIN runs, Luhn failures, EINs with invalid prefixes, SSNs with
000/666/9xx areas.

## Accepted false-positive surface

Any string that IS structurally a valid SSN/EIN/routing/card is treated as one, even when the
surrounding text suggests otherwise (e.g. a phone extension written `555-12-3456`). Determinism
is the contract; block-mode messages tell the operator exactly which TYPE fired so the firm can
switch the class to redact/warn or fix the source data.

## Modes (firm setting `scrubber_mode`)

- **redact** (default since 15C review, Q-056): outbound deep copy gets `[TYPE]` tokens;
  original envelope object untouched; one-way (no de-tokenization exists anywhere);
  `scrubber_redacted` audit event with counts.
- **block**: 422 `scrubber_blocked`, detail = `{matches: {type: count}}` — never values.
  The strictest posture; one click in Firm settings.
- **warn**: pass through unmodified + `scrubber_warning` audit event.

Scope: cloud-bound requests only (selected model kind ≠ `local`); covers every message string,
text content parts, tool-call arguments, and tool results. Scrubber ERRORS block cloud egress
(fail closed) — they never fall through to allow.

## Image screening (8.6)

Everything above reads TEXT. It cannot see inside a page image, so before this control existed
a `cloud_deidentified` vision class — `timebill_file_naming`, `mybooks_receipt_extract` and the
other document-extraction classes — shipped client document scans to a cloud model completely
unexamined. The tier label said "scrubbed"; the pixels were not.

**What runs.** On a cloud-bound request that carries image parts, each image is read by the
firm's own LOCAL vision provider (`local_ocr` preferred — that is what the kind exists for —
otherwise a vision-capable `local` model), and the recognized text goes through the same
detectors as message text. Local-only traffic never triggers it and never pays the latency.

**Screening, not masking.** Masking the pixels of an SSN needs per-character bounding boxes,
which a chat-completions surface does not return. You would be asking a model for coordinates
and trusting them — and a masking control that misses one box fails OPEN: the identifier
reaches the provider while the audit trail records "redacted". Screening fails CLOSED instead.
An image is cleared for cloud egress only if the appliance READ it and found nothing.

**Verdicts.** `clean` proceeds. `identifier` means recognized text carried a protected
identifier. `unreadable` means at least one image could not be examined — a remote `https://`
URL (never fetched; that is the SSRF surface Phase 14 closes), an empty transcription, a
reader error, or no local vision model configured at all. Both non-clean verdicts bar cloud;
they stay distinct in the audit trail because one is a document you may not send and the other
is a screener that is not working.

**When it runs.** A screen is a full local vision inference, not microseconds of regex, so
it runs eagerly only when the primary model is cloud — when the request cannot proceed without
a verdict. The common appliance shape, a local primary with a cloud fallback, defers instead
and pays nothing unless a fallback hop is actually reached. Either way the images are screened
at most once per request, not once per candidate hop.

**Modes.** `block` and `redact` both bar the cloud hop — unlike text, an image has no partial
product, so redact has no weaker action available than refusing. `warn` records
`image_screen_warning` and allows. As with the text scrubber, a local primary still serves the
original; only the cloud hops are barred (`blocked_image_screen`, `scope: fallback_only`).

**Operational consequence.** An appliance with no local vision model cannot send images to any
cloud provider. That is deliberate. If cloud vision is wanted, configure GLM-OCR first (P3 in
`docs/integration-plans/README.md`) — the appliance must be able to see a page before it is
allowed to let anyone else see it.
