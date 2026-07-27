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

- **block** (default): 422 `scrubber_blocked`, detail = `{matches: {type: count}}` — never values.
- **redact**: outbound deep copy gets `[TYPE]` tokens; original envelope object untouched;
  one-way (no de-tokenization exists anywhere).
- **warn**: pass through unmodified + `scrubber_warning` audit event.

Scope: cloud-bound requests only (selected model kind ≠ `local`); covers every message string,
text content parts, tool-call arguments, and tool results. Scrubber ERRORS block cloud egress
(fail closed) — they never fall through to allow.
