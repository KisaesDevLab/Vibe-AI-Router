/**
 * Pure translation layer for the Anthropic Messages API (Phase 4). Fixture-tested without IO.
 *
 * json_schema response_format maps to a FORCED TOOL whose input_schema is the requested schema
 * (works on every Claude model); the tool_use result is translated back into plain content
 * (Q-014). json_object appends a system instruction.
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
import type { ExecuteContext } from '../../gateway/adapter-types.js';
import { RouterError, type ErrorCode } from '../../gateway/errors.js';
import { ProviderHttpError } from '../http.js';
import { providerModelName } from '../openai-compat/translate.js';

export const ANTHROPIC_VERSION = '2023-06-01';
/** name of the synthetic tool used to implement json_schema output */
export function schemaToolName(name: string): string {
  return `emit_${name}`;
}

// ── request translation (4.1/4.2/4.3/4.5) ───────────────────────────────────

type JsonRecord = Record<string, unknown>;

function parseImageUrl(url: string): JsonRecord {
  const dataMatch = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (dataMatch) {
    return { type: 'image', source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2] } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return { __raw: args };
  }
}

export interface AnthropicRequestResult {
  body: JsonRecord;
  /** set when json_schema was mapped to a forced tool — response translation needs it */
  schemaTool?: string;
}

export function buildAnthropicRequest(env: AIRequest, ctx: ExecuteContext): AnthropicRequestResult {
  const model = providerModelName(ctx.model, ctx.modelMapping);

  // system extraction: every system message becomes a system block, in order
  const systemBlocks: JsonRecord[] = [];
  const messages: JsonRecord[] = [];
  for (const m of env.messages) {
    if (m.role === 'system') {
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      systemBlocks.push({ type: 'text', text });
      continue;
    }
    if (m.role === 'tool') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId ?? '',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          },
        ],
      });
      continue;
    }
    const blocks: JsonRecord[] = [];
    if (typeof m.content === 'string') {
      if (m.content.length > 0) blocks.push({ type: 'text', text: m.content });
    } else {
      for (const p of m.content) {
        blocks.push(p.type === 'text' ? { type: 'text', text: p.text } : parseImageUrl(p.url));
      }
    }
    for (const tc of m.toolCalls ?? []) {
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parseArguments(tc.arguments) });
    }
    messages.push({ role: m.role, content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] });
  }

  // tools
  let tools: JsonRecord[] | undefined = env.tools?.map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    input_schema: t.parameters ?? { type: 'object' },
  }));
  let toolChoice: JsonRecord | undefined;
  if (env.toolChoice !== undefined) {
    toolChoice =
      env.toolChoice === 'auto'
        ? { type: 'auto' }
        : env.toolChoice === 'required'
          ? { type: 'any' }
          : env.toolChoice === 'none'
            ? { type: 'none' }
            : { type: 'tool', name: env.toolChoice.name };
  }

  // response_format mapping (Q-014)
  let schemaTool: string | undefined;
  if (env.responseFormat?.type === 'json_schema') {
    schemaTool = schemaToolName(env.responseFormat.name);
    tools = [
      ...(tools ?? []),
      {
        name: schemaTool,
        description: 'Emit the final answer as structured output matching the schema exactly.',
        input_schema: env.responseFormat.schema ?? { type: 'object' },
      },
    ];
    toolChoice = { type: 'tool', name: schemaTool };
  } else if (env.responseFormat?.type === 'json_object') {
    systemBlocks.push({ type: 'text', text: 'Respond with valid JSON only — no prose, no code fences.' });
  }

  // prompt caching breakpoints (4.2): last system block, last tool, end of leading context
  if (ctx.promptCaching) {
    const lastSystem = systemBlocks[systemBlocks.length - 1];
    if (lastSystem) lastSystem['cache_control'] = { type: 'ephemeral' };
    const lastTool = tools?.[tools.length - 1];
    if (lastTool) lastTool['cache_control'] = { type: 'ephemeral' };
    if (messages.length >= 2) {
      const leadingEnd = messages[messages.length - 2];
      const content = leadingEnd?.['content'];
      if (Array.isArray(content) && content.length > 0) {
        (content[content.length - 1] as JsonRecord)['cache_control'] = { type: 'ephemeral' };
      }
    }
  }

  const body: JsonRecord = {
    model,
    // Anthropic REQUIRES max_tokens (4.5) — policy injected it; this is the last-resort default
    max_tokens: env.maxTokens ?? 4096,
    messages,
  };
  if (systemBlocks.length > 0) body['system'] = systemBlocks;
  if (tools?.length) body['tools'] = tools;
  if (toolChoice) body['tool_choice'] = toolChoice;
  if (env.temperature !== undefined) body['temperature'] = env.temperature;
  if (env.topP !== undefined) body['top_p'] = env.topP;
  if (env.stop?.length) body['stop_sequences'] = env.stop;
  if (env.stream) body['stream'] = true;
  if (ctx.thinkingBudget !== undefined && ctx.thinkingBudget > 0) {
    body['thinking'] = { type: 'enabled', budget_tokens: ctx.thinkingBudget };
  }
  return schemaTool !== undefined ? { body, schemaTool } : { body };
}

export function buildAnthropicHeaders(ctx: ExecuteContext): Record<string, string> {
  return {
    ...(ctx.apiKey ? { 'x-api-key': ctx.apiKey } : {}),
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

// ── stop-reason normalization ────────────────────────────────────────────────

const STOP_REASONS: Record<string, FinishReason> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
  pause_turn: 'stop',
};

export function normalizeStopReason(raw: string | null | undefined): FinishReason {
  if (!raw) return 'stop';
  return STOP_REASONS[raw] ?? 'stop';
}

// ── response translation ─────────────────────────────────────────────────────

const usageSchema = z.object({
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cache_creation_input_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
});

const responseSchema = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
      z.object({ type: z.literal('thinking'), thinking: z.string() }),
      z.object({ type: z.literal('redacted_thinking') }).passthrough(),
    ]),
  ),
  stop_reason: z.string().nullish(),
  usage: usageSchema,
});

export function toUsage(raw: z.infer<typeof usageSchema>): AIUsage {
  return {
    promptTokens: raw.input_tokens,
    completionTokens: raw.output_tokens,
    cachedReadTokens: raw.cache_read_input_tokens ?? 0,
    cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
    estimated: false,
  };
}

export function translateAnthropicResponse(
  raw: unknown,
  meta: { model: string; providerId: string; latencyMs: number },
  schemaTool?: string,
): AIResponse {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RouterError('provider_unavailable', 'malformed provider response', {
      detail: { reason: parsed.error.issues[0]?.message ?? 'parse failure' },
    });
  }
  let content = '';
  let thinking = '';
  const toolCalls: ToolCall[] = [];
  for (const block of parsed.data.content) {
    if (block.type === 'text') content += block.text;
    else if (block.type === 'thinking') thinking += block.thinking;
    else if (block.type === 'tool_use') {
      if (schemaTool && block.name === schemaTool) {
        // synthetic schema tool → the structured output IS the content (Q-014)
        content += JSON.stringify(block.input);
      } else {
        toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      }
    }
  }
  let finishReason = normalizeStopReason(parsed.data.stop_reason);
  if (schemaTool && finishReason === 'tool_calls' && toolCalls.length === 0) finishReason = 'stop';
  return {
    message: { role: 'assistant', content, ...(toolCalls.length ? { toolCalls } : {}) },
    finishReason,
    usage: toUsage(parsed.data.usage),
    served: meta,
    ...(thinking ? { thinking } : {}),
  };
}

// ── streaming event translation (4.4) ────────────────────────────────────────

const streamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_start'), message: z.object({ usage: usageSchema }) }),
  z.object({
    type: z.literal('content_block_start'),
    index: z.number(),
    content_block: z.union([
      z.object({ type: z.literal('text') }).passthrough(),
      z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string() }),
      z.object({ type: z.literal('thinking') }).passthrough(),
      z.object({ type: z.literal('redacted_thinking') }).passthrough(),
    ]),
  }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.number(),
    delta: z.union([
      z.object({ type: z.literal('text_delta'), text: z.string() }),
      z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }),
      z.object({ type: z.literal('thinking_delta'), thinking: z.string() }),
      z.object({ type: z.literal('signature_delta') }).passthrough(),
    ]),
  }),
  z.object({ type: z.literal('content_block_stop'), index: z.number() }),
  z.object({
    type: z.literal('message_delta'),
    delta: z.object({ stop_reason: z.string().nullish() }),
    usage: z.object({ output_tokens: z.number().optional() }).nullish(),
  }),
  z.object({ type: z.literal('message_stop') }),
  z.object({ type: z.literal('ping') }),
  z.object({
    type: z.literal('error'),
    error: z.object({ type: z.string(), message: z.string() }),
  }),
]);

export type AnthropicStreamEvent = z.infer<typeof streamEventSchema>;

export function parseStreamEvent(raw: unknown): AnthropicStreamEvent | undefined {
  const parsed = streamEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Stream state machine: folds Anthropic events into internal chunks. Instantiated per stream
 * (translateStreamChunk on the adapter delegates single text/tool frames here statelessly).
 */
export class AnthropicStreamState {
  private usage: AIUsage = {
    promptTokens: 0,
    completionTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    estimated: false,
  };
  private stopReason: FinishReason = 'stop';
  private toolIndexByBlock = new Map<number, number>();
  private blockTypes = new Map<number, string>();
  private nextToolIndex = 0;
  private readonly schemaTool: string | undefined;
  private schemaBlockIndex: number | undefined;

  constructor(schemaTool?: string) {
    this.schemaTool = schemaTool;
  }

  handle(event: AnthropicStreamEvent): StreamChunk[] {
    switch (event.type) {
      case 'message_start': {
        this.usage = toUsage(event.message.usage);
        return [];
      }
      case 'content_block_start': {
        this.blockTypes.set(event.index, event.content_block.type);
        if (event.content_block.type === 'tool_use') {
          if (this.schemaTool && event.content_block.name === this.schemaTool) {
            this.schemaBlockIndex = event.index; // structured output → emitted as text deltas
            return [];
          }
          const toolIndex = this.nextToolIndex++;
          this.toolIndexByBlock.set(event.index, toolIndex);
          return [
            {
              type: 'tool_call_start',
              index: toolIndex,
              id: event.content_block.id,
              name: event.content_block.name,
            },
          ];
        }
        return [];
      }
      case 'content_block_delta': {
        if (event.delta.type === 'text_delta') return [{ type: 'text_delta', delta: event.delta.text }];
        if (event.delta.type === 'input_json_delta') {
          if (this.schemaBlockIndex === event.index) {
            return [{ type: 'text_delta', delta: event.delta.partial_json }];
          }
          const toolIndex = this.toolIndexByBlock.get(event.index);
          if (toolIndex === undefined) return [];
          return [{ type: 'tool_call_delta', index: toolIndex, argumentsDelta: event.delta.partial_json }];
        }
        return []; // thinking/signature deltas are never relayed into persisted-adjacent surfaces
      }
      case 'message_delta': {
        if (event.delta.stop_reason) this.stopReason = normalizeStopReason(event.delta.stop_reason);
        if (event.usage?.output_tokens !== undefined) this.usage.completionTokens = event.usage.output_tokens;
        return [];
      }
      case 'message_stop': {
        let finish = this.stopReason;
        if (this.schemaBlockIndex !== undefined && finish === 'tool_calls' && this.nextToolIndex === 0) {
          finish = 'stop';
        }
        return [{ type: 'finish', finishReason: finish, usage: this.usage }];
      }
      case 'error': {
        throw mapAnthropicStreamError(event.error.type, event.error.message);
      }
      case 'content_block_stop':
      case 'ping':
        return [];
    }
  }
}

// ── error mapping (4.6) ──────────────────────────────────────────────────────

function codeForAnthropicType(type: string): ErrorCode {
  switch (type) {
    case 'authentication_error':
    case 'permission_error':
      return 'auth_error';
    case 'rate_limit_error':
      return 'rate_limited';
    case 'overloaded_error':
      return 'provider_unavailable'; // retryable per taxonomy
    case 'request_too_large':
      return 'context_exceeded';
    case 'api_error':
      return 'provider_unavailable';
    default:
      return 'provider_unavailable';
  }
}

export function mapAnthropicStreamError(type: string, message: string): RouterError {
  return new RouterError(codeForAnthropicType(type), `provider error (${type})`, {
    detail: { providerErrorType: type, providerMessage: message.slice(0, 500) },
  });
}

export function mapAnthropicError(err: unknown): RouterError {
  if (err instanceof RouterError) return err;
  if (err instanceof ProviderHttpError) {
    let type = '';
    let message = '';
    try {
      const body = JSON.parse(err.bodyText) as { error?: { type?: string; message?: string } };
      type = body.error?.type ?? '';
      message = body.error?.message ?? '';
    } catch {
      /* non-JSON body */
    }
    let code: ErrorCode;
    if (type) {
      code = codeForAnthropicType(type);
      if (type === 'invalid_request_error') {
        code = /prompt is too long|too many tokens|context/i.test(message)
          ? 'context_exceeded'
          : 'invalid_request';
      }
    } else if (err.status === 401 || err.status === 403) code = 'auth_error';
    else if (err.status === 429) code = 'rate_limited';
    else if (err.status === 529 || err.status >= 500) code = 'provider_unavailable';
    else code = 'provider_unavailable';
    return new RouterError(code, `provider error (HTTP ${err.status})`, {
      detail: {
        providerStatus: err.status,
        ...(type ? { providerErrorType: type } : {}),
        providerBody: err.bodyText.slice(0, 500),
      },
      ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    });
  }
  if (err instanceof TypeError) {
    return new RouterError('provider_unavailable', 'provider unreachable', {
      detail: { reason: err.message },
    });
  }
  return new RouterError('unknown', err instanceof Error ? err.message : 'adapter failure');
}
