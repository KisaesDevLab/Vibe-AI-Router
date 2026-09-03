# @kisaes/vibe-ai-client — changelog

The SDK follows the router's major version (`docs/integration.md` §12.8). **Any change to
`VibeAiErrorCode` is a public type change and gets a version bump even when the wire is
additive** — an app that vendors an older `dist/` has a narrower union and cannot know.
Router-side history for each SDK release is in the repository root `CHANGELOG.md`.

## 0.2.3 — 2026-09-03 (router 0.0.25)

Raised by Vibe 1040 (`docs/plan-vibe-1040-followups.md`, item A).

- **`no_vision_provider` and `invalid_response` are now guaranteed in the published union.**
  The router has sent both since 0.0.19 / 0.0.24 and `src/index.ts` listed them, but 0.2.2
  was never re-published after they were added, so a `dist/` vendored under `0.2.2` could lack
  them and route both codes to an app's `default` branch. `VibeAiErrorCode` is now derived from
  a runtime array, `VIBE_AI_ERROR_CODES`, and the router's test suite asserts that array is a
  superset of its own `ERROR_CODES` (`test/sdk-error-codes.test.ts`), so the two cannot drift
  silently again.
- **`InvalidResponseReason` / `INVALID_RESPONSE_REASONS` / `InvalidResponseDetail`** — the
  `detail.reason` vocabulary of `invalid_response` (`empty_response`, `provider_error_finish`,
  `tool_arguments_not_json`, `response_not_json`, `json_truncated`, `schema_violation`) and
  `detail.path`, mirrored from `src/gateway/verify.ts` and asserted equal in tests.
- **`isInvalidResponse(err)`** type guard narrows to `VibeAiError & { code: 'invalid_response';
  detail: InvalidResponseDetail }` so apps branch on `detail.reason` without string literals.
  Park on `json_truncated` (raise the class's `max_tokens` or ask for less — a re-roll cannot
  help); the other reasons are stochastic and a single fresh attempt may succeed.
- **`retryable` is unchanged** (`true` for `invalid_response`), with the doc comment corrected:
  the router already retried the same model and walked the whole fallback chain before
  returning it, so a fresh call is a re-roll, not a fix.
- **`responseFormat.validation?: 'structural' | 'strict'`** (also on `completeJson`'s schema
  argument) — router-side verification mode for forced JSON, never forwarded to a provider.
  `structural` (default since router 0.0.25) enforces `required`/`type`/`items` and tolerates
  `enum` misses (audited router-side as `schema_enum_miss`); `strict` rejects an enum miss as
  `invalid_response`, which is what the router did unconditionally in 0.0.24. Exported as
  `SchemaValidationMode`. A 0.0.24 router strips the unknown key and behaves as `strict`
  (its only mode), so sending it is safe against either version.
- `pnpm test` inside `packages/sdk` now runs the SDK suites through the repository root
  vitest config (`test/sdk*.test.ts`).

## 0.2.2 — 2026-08-25 (router 0.0.19)

- `no_vision_provider` added to `VibeAiErrorCode` (HTTP 409, structured vision skip).
- `budgetPrecheck()` wrapper for `POST /v1/budget/precheck`.
- `timebill_*` task-class keys in `TASK_CLASSES`.

## 0.2.1 — 2026-08-24 (router 0.0.18)

- `completeJson` checks `finishReason` **before** parsing and throws
  `VibeAiError('output_truncated')` — carrying the served completion-token count — when a
  forced-JSON response is cut off at `max_tokens`. Previously surfaced as a misleading "not
  valid JSON" or, worse, a parseable-but-incomplete prefix returned as success.
- `output_truncated` added to `VibeAiErrorCode` (SDK-synthesized; the router has no such code).

## 0.2.0

- `completeJson` (R3): forced-JSON completion returning the parsed object, tolerant of
  markdown fences.
- `prepare` script so downstream git-dependency installs build `dist/` on install.
- Default per-request timeout (`timeoutMs`, 120 s) so a hung router can never hang an app.
