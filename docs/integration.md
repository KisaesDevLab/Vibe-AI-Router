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
