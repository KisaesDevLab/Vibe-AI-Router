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

`ResponseFormat`: `{type:'text'}` | `{type:'json_object'}` | `{type:'json_schema', name,
schema, strict?, validation?}`. On the wire the json_schema fields sit under
`response_format.json_schema`. `strict` is OpenAI's constrained-decoding flag and is forwarded
to providers that support it. `validation` (`'structural'` | `'strict'`, added 0.0.25) is
a **router extension that never reaches a provider**: it selects how `src/gateway/verify.ts`
grades the response. Resolution (Q-099): explicit `validation` → else `strict: true` counts as a
strict hint → else `ROUTER_SCHEMA_VALIDATION` (structural by default). In `anyOf`/`oneOf`,
branches are matched strictly first, so an enum discriminator always discriminates.
Structural enforces `required`/`type`/`items` and treats an `enum` miss
as a soft finding — audited as `response_soft_finding` (`reason: 'schema_enum_miss'`, count,
first path) and counted in `vibe_router_response_soft_findings_total` — while the response
still serves. Strict makes an enum miss a hard `schema_violation`, i.e. an `invalid_response`
that triggers same-model retry and the fallback chain.

`AIResponse`: `{ message { role:'assistant', content, toolCalls? }, finishReason: stop|length|
tool_calls|content_filter|error, usage { promptTokens, completionTokens, cachedReadTokens,
cacheWriteTokens, estimated }, served { model, providerId, latencyMs }, thinking? }`

Usage semantics (extension, 9.1): `promptTokens` is DISJOINT from `cachedReadTokens`/`cacheWriteTokens`
(uncached input only). OpenAI wire responses re-add cached into `prompt_tokens` for client
compatibility. `estimated=true` marks router-estimated usage when a provider omitted it.

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
| `no_vision_provider` | 409 | no |
| `provider_unavailable` | 502 | yes |
| `invalid_response` | 502 | yes |
| `unknown` | 500 | no |

Body: `{ error: { message, type, code, detail? } }` — `detail` never contains message bodies or
matched scrubber values. `Retry-After` set when known.

`invalid_response` means every hop in the policy chain answered but none produced a usable
result (empty completion, forced-JSON answered with prose, tool arguments that are not JSON, a
schema violation). Its `detail.reason` names which check failed (`INVALID_RESPONSE_REASONS` in
`src/gateway/verify.ts`, mirrored by the SDK) and `detail.path` the schema pointer — never the
offending value. Verification is per hop, so the client sees this only after same-model retries
and the whole fallback chain were exhausted; "retryable: yes" therefore means a fresh request is
a re-roll, not that the router left anything untried. `json_truncated` short-circuits the
same-model retry (deterministic cutoff) and advances the chain immediately. Under the default
structural validation an `enum` miss is NOT an `invalid_response` — see `ResponseFormat`
above. See also `ROUTER_VERIFY_RESPONSES`.

## Request identity

- `requestId`: UUID minted at ingress, returned as `x-request-id`, ledger idempotency key.
- `requestHash`: SHA-256 over key-sorted canonical JSON of `messages` — the correlation key in
  logs/ledger/audit. Bodies themselves are never persisted.

## Limits (2.9)

`ROUTER_MAX_BODY_BYTES` (10 MiB), `ROUTER_MAX_MESSAGES` (200), `ROUTER_MAX_JSON_DEPTH` (24) —
all env-tunable, violations → `invalid_request` (depth checked before schema parse).

## Pipeline order (fixed)

`auth → resolveTaskClass → policy → budget → scrub → route → adapt → ledger → respond` —
(budget stage added in Phase 9 as an extension). Every stage independently re-validates what
it depends on (server-side enforcement, principle 5).
