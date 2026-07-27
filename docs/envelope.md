# Internal envelope & wire contract (FROZEN — Phase 2)

Later phases may extend, not break. Types: `src/gateway/envelope.ts`. Errors:
`src/gateway/errors.ts`.

## Wire surface

`POST /v1/chat/completions` — OpenAI-compatible chat body. The official `openai` client works
unmodified (contract-tested). Additions:

| Header | Required | Meaning |
| --- | --- | --- |
| `Authorization: Bearer <app token>` | yes | app token issued at appliance provisioning |
| `X-Vibe-Task-Class` | **yes — reject without it (fail closed)** | task-class key, e.g. `tb_classification` |
| `X-Vibe-Engagement` | no | engagement ref for ledger attribution |
| `X-Vibe-Client` | no | client ref for T&B cost-recovery feed |
| `X-Vibe-User` | no | app-side user id (role gating, per-user budgets) |
| `X-Vibe-User-Role` | no | `admin` \| `partner` \| `staff` |

`model` in the body is advisory (`modelRequested`); **policy decides what is served**.
Responses carry `x-request-id` and a `vibe: { provider_id, latency_ms }` extension field.

## Internal envelope

`AIRequest`: `{ taskClass, messages[], tools?, toolChoice?, responseFormat?, maxTokens?,
temperature?, topP?, stop?, stream, modelRequested?, metadata { app, userId?, userRole?,
engagementRef?, clientRef? } }`

`AIMessage`: `{ role: system|user|assistant|tool, content: string | ContentPart[], toolCalls?,
toolCallId? }`; `ContentPart`: `{type:'text',text}` | `{type:'image',url}`.
`developer` role normalizes to `system`. `max_completion_tokens` wins over `max_tokens`.

`AIResponse`: `{ message { role:'assistant', content, toolCalls? }, finishReason: stop|length|
tool_calls|content_filter|error, usage { promptTokens, completionTokens, cachedReadTokens,
cacheWriteTokens, estimated }, served { model, providerId, latencyMs } }`

`StreamChunk`: `text_delta | tool_call_start | tool_call_delta | finish{finishReason, usage?}`.
Usage arrives on the final chunk; the SSE relay emits an OpenAI-shaped usage chunk after the
finish chunk.

## Error taxonomy

| code | HTTP | retryable |
| --- | --- | --- |
| `invalid_request` | 400 | no |
| `auth_error` | 401 | no |
| `budget_exceeded` | 402 | no |
| `policy_blocked` | 403 | no |
| `rate_limited` | 429 | yes |
| `context_exceeded` | 400 | no |
| `content_filtered` | 422 | no |
| `scrubber_blocked` | 422 | no |
| `capability_missing` | 400 | no |
| `provider_unavailable` | 502 | yes |
| `unknown` | 500 | no |

Body: `{ error: { message, type, code, detail? } }` — `detail` never contains message bodies or
matched scrubber values. `Retry-After` set when known.

## Request identity

- `requestId`: UUID minted at ingress, returned as `x-request-id`, ledger idempotency key.
- `requestHash`: SHA-256 over key-sorted canonical JSON of `messages` — the correlation key in
  logs/ledger/audit. Bodies themselves are never persisted.

## Limits (2.9)

`ROUTER_MAX_BODY_BYTES` (10 MiB), `ROUTER_MAX_MESSAGES` (200), `ROUTER_MAX_JSON_DEPTH` (24) —
all env-tunable, violations → `invalid_request` (depth checked before schema parse).

## Pipeline order (fixed)

`auth → resolveTaskClass → policy → scrub → route → adapt → ledger → respond` — every stage
independently re-validates what it depends on (server-side enforcement, principle 5).
