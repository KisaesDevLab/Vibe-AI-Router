# App integration contract (FROZEN — Phase 12)

The contract every Vibe app builds against. Wire details: docs/envelope.md. Client:
`@kisaes/vibe-ai-client` (packages/sdk). **Apps never hold provider keys and never call AI
providers directly — all AI traffic goes through the router. No exceptions, no "temporary"
direct calls.**

## Auth

Each app receives one **app token** at appliance provisioning (minted in the admin UI →
App tokens, or `POST /admin-api/app-tokens`). Plaintext is shown once; the router stores a
SHA-256 hash. Pass as `Authorization: Bearer <token>`. Rotate by minting a new token, swapping
the app env, revoking the old.

## Startup: declare your task classes

```ts
import { VibeAiClient } from '@kisaes/vibe-ai-client';

const ai = new VibeAiClient({ baseUrl: process.env.VIBE_AI_ROUTER_URL!, token: process.env.VIBE_AI_TOKEN! });

await ai.registerTaskClasses({
  app: 'vibe-tb',
  version: APP_VERSION,
  classes: [
    { key: 'tb_classification', requires: { json_schema: true }, defaultMaxTokens: 2048 },
  ],
});
```

Registration is idempotent and version-stamped. A class the router has never seen is created
**local_only** regardless of what you ask for; only the firm admin can widen it (deliberately,
audited). Registration never changes an existing class's sensitivity.

## Requests

```ts
const result = await ai.complete('tb_classification', [
  { role: 'system', content: CLASSIFY_PROMPT },
  { role: 'user', content: row.description },
], {
  responseFormat: { type: 'json_schema', name: 'account', schema: ACCOUNT_SCHEMA },
  userId: session.userId, userRole: session.role,      // role gating + per-user budgets
  engagementRef: engagement.id, clientRef: client.id,  // ledger + T&B cost recovery
});
```

- `model` is advisory; **policy decides what serves**. Handle any model's output shape.
- Streaming: `for await (const ev of ai.stream(...))` — deltas, then `finishReason`, then `usage`.
- Budget soft warnings arrive on `result.budgetWarnings` — surface them to firm admins.

## Errors — handle by taxonomy code, not status

| code | what your app should do |
| --- | --- |
| `scrubber_blocked` | tell the user protected data (types are in `detail.matches`) can't go to cloud for this task; do NOT retry |
| `policy_blocked` | feature is disabled/misconfigured for this firm — surface admin-facing message |
| `budget_exceeded` | firm/app/user budget exhausted — surface, do not retry until next period |
| `rate_limited`, `provider_unavailable` | retryable (`err.retryable === true`); honor `retryAfterSeconds` |
| `capability_missing`, `invalid_request` | app bug or config gap — log loudly |
| `context_exceeded` | shrink the prompt |
| `auth_error` | app token missing, revoked, or wrong firm — re-provision; never retry in a loop |
| `content_filtered` | the provider refused (HTTP 422). Terminal for this input — the router does not retry a refusal, and neither should you |
| `no_vision_provider` | HTTP 409 (since 0.0.19): the class requires `vision` and no bound model advertises it — usually a discovered model that was never probed. **Park** the work; an admin fixes it in the console (Catalog → probe, or `POST /admin-api/models/:id/probe`) and the next attempt routes |
| `invalid_response` | HTTP 502 (since 0.0.24): the router verified the response against your `json_schema` (or found it empty / not JSON), **already retried the same model and walked the whole fallback chain**, and every hop failed. `err.retryable` is `true`, but a fresh call is a re-roll of stochastic output, not a fix — retry at most once, then surface it. `detail.reason` is one of `json_truncated`, `schema_violation`, `response_not_json`, `empty_response`, `provider_error_finish`, `tool_arguments_not_json`; `detail.path` is the schema path for a violation (never the value). For `json_truncated` do **not** retry: raise the class's `max_tokens` (or the policy override) or ask for less. Use `isInvalidResponse(err)` (SDK ≥ 0.2.3) to branch on the reason with types |
| `output_truncated` | **SDK-side** (`completeJson` only, since v0.2.1): the forced-JSON response was cut off at `max_tokens` (`finish_reason: 'length'`). `detail.completionTokens` is the served count. Not retryable as-is — raise the class's `max_tokens`/policy override, or split the input. Since router 0.0.24 the router usually catches the cutoff first and returns `invalid_response` / `json_truncated`, so handle both |
| `unknown` | HTTP 500 — log with the `x-request-id` header (`result.requestId` / `detail.requestId`) and surface as a generic failure |

Forced-JSON verification is **structural** by default (since 0.0.25): `required` / `type` /
`items` from your schema are enforced, an `enum` miss is tolerated (audited router-side as
`schema_enum_miss`) and the response is returned for your own code to reconcile. Pass
`responseFormat.validation: 'strict'` to have enum misses rejected as `invalid_response`
instead. `strict: true` (OpenAI's constrained-decoding flag) is a separate, provider-facing
setting.

## Versioning (12.8)

- The wire contract (endpoints, headers, error codes, envelope semantics) is **semver-major**
  frozen: breaking changes only with a router major release and a deprecation window of one
  minor release during which both behaviors work.
- `@kisaes/vibe-ai-client` follows the router's major version. Additive fields are minor.
- Deprecations are announced in CHANGELOG + an audit `config_change` event on upgrade.

## Environment (per app, set by appliance provisioning)

```
VIBE_AI_ROUTER_URL=http://vibe-ai-router:8220   # internal docker network — never via Caddy
VIBE_AI_TOKEN=<minted app token>
```
