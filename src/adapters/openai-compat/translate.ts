/**
 * Pure translation layer for the OpenAI-compatible family (OpenAI, Azure OpenAI, Ollama /v1,
 * Groq, DeepSeek). Fixture-tested without IO. Quirks table: docs/adapter-contract.md.
 */
import { z } from 'zod';
import type {
  AIRequest,
  AIResponse,
  AIUsage,
  FinishReason,
  StreamChunk,
  ToolCall,
} from '../../gateway/envelope.js';
import { EMPTY_USAGE } from '../../gateway/envelope.js';
import type { ExecuteContext } from '../../gateway/adapter-types.js';
import { RouterError, type ErrorCode } from '../../gateway/errors.js';
import { ProviderHttpError } from '../http.js';

// ── flavor detection ─────────────────────────────────────────────────────────

export type Flavor = 'openai' | 'azure' | 'ollama' | 'groq' | 'deepseek' | 'generic';

export function detectFlavor(baseUrl: string): Flavor {
  const host = (() => {
    try {
      return new URL(baseUrl).host.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (host.endsWith('azure.com') || host.includes('.openai.azure.')) return 'azure';
  if (host === 'api.openai.com') return 'openai';
  if (host === 'api.groq.com') return 'groq';
  if (host === 'api.deepseek.com') return 'deepseek';
  if (host.includes('11434') || host.includes('ollama') || host.includes('vibellm')) return 'ollama';
  return 'generic';
}

/** canonical `prefix/model` → provider-native model name; provider model_mapping wins. */
export function providerModelName(canonicalId: string, mapping?: Record<string, string>): string {
  if (mapping && mapping[canonicalId]) return mapping[canonicalId];
  const slash = canonicalId.indexOf('/');
  return slash === -1 ? canonicalId : canonicalId.slice(slash + 1);
}

// ── request translation ──────────────────────────────────────────────────────

export function buildRequestBody(env: AIRequest, model: string, flavor: Flavor): Record<string, unknown> {
  const messages = env.messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role };
    if (typeof m.content === 'string') base['content'] = m.content;
    else
      base['content'] = m.content.map((p) =>
        p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.url } },
      );
    if (m.toolCalls?.length) {
      base['tool_calls'] = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }));
      if (base['content'] === '') base['content'] = null;
    }
    if (m.toolCallId) base['tool_call_id'] = m.toolCallId;
    return base;
  });

  const body: Record<string, unknown> = { model, messages, stream: env.stream };
  if (env.stream && flavor !== 'ollama') {
    // usage on the final chunk (3.6); Ollama /v1 rejects unknown stream_options on older builds
    body['stream_options'] = { include_usage: true };
  }
  if (env.maxTokens !== undefined) body['max_tokens'] = env.maxTokens;
  if (env.temperature !== undefined) body['temperature'] = env.temperature;
  if (env.topP !== undefined) body['top_p'] = env.topP;
  if (env.stop?.length) body['stop'] = env.stop;
  if (env.tools?.length) {
    body['tools'] = env.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
      },
    }));
  }
  if (env.toolChoice !== undefined) {
    body['tool_choice'] =
      typeof env.toolChoice === 'string'
        ? env.toolChoice
        : { type: 'function', function: { name: env.toolChoice.name } };
  }
  if (env.responseFormat) {
    if (env.responseFormat.type === 'json_schema') {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: {
          name: env.responseFormat.name,
          schema: env.responseFormat.schema,
          ...(env.responseFormat.strict !== undefined ? { strict: env.responseFormat.strict } : {}),
        },
      };
    } else {
      body['response_format'] = { type: env.responseFormat.type };
    }
  }
  return body;
}

/** Azure: deployment in path + api-version query + `api-key` header (3.3/3.4). */
export function buildUrl(ctx: ExecuteContext, model: string, flavor: Flavor): string {
  const base = ctx.baseUrl.replace(/\/+$/, '');
  if (flavor === 'azure') {
    const u = new URL(base);
    const apiVersion = u.searchParams.get('api-version') ?? '2024-10-21';
    const root = `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\/openai$/, '')}`;
    return `${root}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${apiVersion}`;
  }
  return `${base}/chat/completions`;
}

export function buildHeaders(ctx: ExecuteContext, flavor: Flavor): Record<string, string> {
  if (!ctx.apiKey) return {};
  if (flavor === 'azure') return { 'api-key': ctx.apiKey };
  return { authorization: `Bearer ${ctx.apiKey}` };
}

// ── finish-reason normalization (3.7) ────────────────────────────────────────

const FINISH_REASONS: Record<string, FinishReason> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls', // legacy OpenAI
  content_filter: 'content_filter', // OpenAI/Azure
  eos: 'stop', // some llama.cpp-family servers
  end_turn: 'stop', // proxies bridging Anthropic
  max_tokens: 'length', // ditto
  insufficient_system_resource: 'error', // DeepSeek overload
};

export function normalizeFinishReason(raw: string | null | undefined): FinishReason {
  if (!raw) return 'stop';
  return FINISH_REASONS[raw] ?? 'stop';
}

// ── response translation ─────────────────────────────────────────────────────

const usageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).nullish(),
    // DeepSeek reports cache hits natively
    prompt_cache_hit_tokens: z.number().optional(),
  })
  .nullish();

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().optional(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .nullish(),
        }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: usageSchema,
});

export function extractUsage(raw: z.infer<typeof usageSchema>): AIUsage {
  if (!raw || (raw.prompt_tokens === undefined && raw.completion_tokens === undefined)) {
    return { ...EMPTY_USAGE, estimated: true }; // provider omitted usage — caller estimates (3.6)
  }
  return {
    promptTokens: raw.prompt_tokens ?? 0,
    completionTokens: raw.completion_tokens ?? 0,
    cachedReadTokens: raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0,
    cacheWriteTokens: 0,
    estimated: false,
  };
}

export function translateResponse(
  raw: unknown,
  meta: { model: string; providerId: string; latencyMs: number },
): AIResponse {
  const parsed = completionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RouterError('provider_unavailable', 'malformed provider response', {
      detail: { reason: parsed.error.issues[0]?.message ?? 'parse failure' },
    });
  }
  const choice = parsed.data.choices[0];
  if (!choice) throw new RouterError('provider_unavailable', 'provider returned no choices');
  const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.length
    ? choice.message.tool_calls.map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }))
    : undefined;
  return {
    message: {
      role: 'assistant',
      content: choice.message.content ?? '',
      ...(toolCalls ? { toolCalls } : {}),
    },
    finishReason:
      toolCalls && !choice.finish_reason ? 'tool_calls' : normalizeFinishReason(choice.finish_reason),
    usage: extractUsage(parsed.data.usage),
    served: meta,
  };
}

// ── stream chunk translation ─────────────────────────────────────────────────

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().optional(),
                  id: z.string().nullish(),
                  function: z
                    .object({ name: z.string().nullish(), arguments: z.string().nullish() })
                    .nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
  usage: usageSchema,
});

/**
 * One provider chunk → zero or more internal chunks. Stateless by design; the adapter's
 * stream loop pairs a trailing usage-only chunk with the finish it already saw.
 */
export function translateStreamChunk(raw: unknown): StreamChunk[] {
  const parsed = chunkSchema.safeParse(raw);
  if (!parsed.success) return []; // tolerate unknown keep-alive shapes (3.3 quirk tolerance)
  const out: StreamChunk[] = [];
  const choice = parsed.data.choices?.[0];
  if (choice?.delta?.content) out.push({ type: 'text_delta', delta: choice.delta.content });
  for (const tc of choice?.delta?.tool_calls ?? []) {
    const index = tc.index ?? 0;
    if (tc.id != null && tc.function?.name != null) {
      out.push({ type: 'tool_call_start', index, id: tc.id, name: tc.function.name });
    }
    if (tc.function?.arguments) {
      out.push({ type: 'tool_call_delta', index, argumentsDelta: tc.function.arguments });
    }
  }
  if (choice?.finish_reason) {
    out.push({ type: 'finish', finishReason: normalizeFinishReason(choice.finish_reason) });
  }
  if (parsed.data.usage && parsed.data.usage.prompt_tokens !== undefined) {
    // usage-only trailing chunk (stream_options.include_usage)
    out.push({
      type: 'finish',
      finishReason: 'stop',
      usage: extractUsage(parsed.data.usage),
    });
  }
  return out;
}

// ── error mapping (3.8) ──────────────────────────────────────────────────────

export function mapProviderError(err: unknown): RouterError {
  if (err instanceof RouterError) return err;
  if (err instanceof ProviderHttpError) {
    const body = err.bodyText.toLowerCase();
    let code: ErrorCode;
    if (err.status === 401 || err.status === 403) code = 'auth_error';
    else if (err.status === 429) code = 'rate_limited';
    else if (
      err.status === 400 &&
      (body.includes('context_length') || body.includes('context length') || body.includes('maximum context'))
    )
      code = 'context_exceeded';
    else if (err.status === 400 && body.includes('content_filter')) code = 'content_filtered';
    else if (err.status >= 500 || err.status === 404 || err.status === 408) code = 'provider_unavailable';
    else code = 'provider_unavailable';
    return new RouterError(code, `provider error (HTTP ${err.status})`, {
      // raw detail preserved for audit, bodies are provider ERROR payloads and truncated (3.8)
      detail: { providerStatus: err.status, providerBody: err.bodyText.slice(0, 500) },
      ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    });
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new RouterError('unknown', 'request aborted');
  }
  if (err instanceof TypeError) {
    // fetch network failure (ECONNREFUSED, DNS, TLS)
    return new RouterError('provider_unavailable', 'provider unreachable', {
      detail: { reason: err.message },
    });
  }
  return new RouterError('unknown', err instanceof Error ? err.message : 'adapter failure');
}

/** char-based fallback when a provider omits usage entirely (3.6) — flagged estimated. */
export function estimateUsage(env: AIRequest, completionText: string): AIUsage {
  const promptChars = JSON.stringify(env.messages).length;
  return {
    promptTokens: Math.max(1, Math.ceil(promptChars / 4)),
    completionTokens: Math.max(completionText.length > 0 ? 1 : 0, Math.ceil(completionText.length / 4)),
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    estimated: true,
  };
}
