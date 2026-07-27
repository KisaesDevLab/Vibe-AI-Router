# ProviderAdapter contract (FROZEN — Phase 3)

Types: `src/adapters/contract.ts`. Adapters are the only code that sees provider shapes; the
core sees only the envelope (principle 8). Later phases extend, never break.

## Interface

| Method | Purity | Purpose |
| --- | --- | --- |
| `capabilities()` | pure | static family capabilities (config-time gating input) |
| `translateRequest(env, ctx)` | pure | envelope → `{url, method, headers, body}`; secrets enter here only |
| `execute(env, ctx, signal)` | IO | non-streaming call → `AIResponse` |
| `executeStream(env, ctx, signal)` | IO | streaming call → `AsyncIterable<StreamChunk>` |
| `translateResponse(raw, meta)` | pure | provider JSON → `AIResponse` (fixture-tested) |
| `translateStreamChunk(raw)` | pure | provider event → `StreamChunk[]` (fixture-tested) |
| `testConnection(ctx, signal)` | IO | minimal live check → `{ok, latencyMs, errorCode?, probedCapabilities?}` |

Rules:

- **Usage**: extract when present; when absent, estimate (char/4) and set `usage.estimated=true`
  — never report zeros as fact (3.6).
- **Finish reasons** normalize through one table (translate.ts `FINISH_REASONS`); unknown → `stop`.
- **Errors** map to the taxonomy via one function per family (`mapProviderError`); raw provider
  error bodies are truncated to 500 chars into `detail.providerBody` for audit — provider error
  payloads never contain request messages.
- **Streaming**: a held `finish` merges with a trailing usage-only chunk; if the stream ends with
  no usage, emit `finish` with estimated usage.

## OpenAI-compatible family — quirks table (3.3)

| Variant | Detection | URL | Auth | Quirks |
| --- | --- | --- | --- | --- |
| OpenAI | host `api.openai.com` | `{base}/chat/completions` | `Authorization: Bearer` | reference behavior; `stream_options.include_usage` |
| Azure OpenAI | host `*.azure.com` | `{origin}/openai/deployments/{deployment}/chat/completions?api-version=…` | `api-key` header | deployment name = model, resolved via provider `model_mapping` (3.4); api-version taken from base_url query, default `2024-10-21`; content-filter errors are HTTP 400 with `content_filter` in body |
| Ollama | host contains `11434`/`ollama`/`vibellm` | `{base}/chat/completions` (`{base}` ends in `/v1`) | none | `stream_options` omitted (older builds reject unknown fields); usage may be absent → estimated; capability probe via `POST {root}/api/show` → `capabilities[]` + `*.context_length` (3.5) |
| Groq | host `api.groq.com` | standard | Bearer | fast SSE cadence; standard usage |
| DeepSeek | host `api.deepseek.com` | standard | Bearer | `prompt_cache_hit_tokens` → cachedReadTokens; `insufficient_system_resource` finish → `error` |
| generic | anything else | standard | Bearer | unknown SSE keep-alive shapes tolerated (non-JSON `data:` skipped, unparseable chunks yield `[]`) |

## Model naming

Catalog `canonical_id` is `family/native-name` (`openai/gpt-4o-mini`, `ollama/qwen3:14b`).
Adapters strip the family prefix for the wire; `provider.model_mapping[canonical_id]` overrides
entirely (Azure deployments, renamed local tags).
