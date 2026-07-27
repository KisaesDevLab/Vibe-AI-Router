/**
 * Internal envelope (2.1/2.2) — THE one message format. Core logic (policy, scrubbing, ledger,
 * fallbacks) operates only on these shapes; adapters translate at the edge. Frozen contract:
 * docs/envelope.md. Later phases may extend, not break.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RouterError } from './errors.js';

// ── envelope types ───────────────────────────────────────────────────────────

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ContentPartText {
  type: 'text';
  text: string;
}
export interface ContentPartImage {
  type: 'image';
  /** data: URI or https URL, exactly as supplied by the app */
  url: string;
}
export type ContentPart = ContentPartText | ContentPartImage;

export interface ToolCall {
  id: string;
  name: string;
  /** raw JSON string of arguments (kept as string — adapters re-emit verbatim) */
  arguments: string;
}

export interface AIMessage {
  role: Role;
  content: string | ContentPart[];
  /** assistant messages that invoked tools */
  toolCalls?: ToolCall[];
  /** tool result messages: id of the call being answered */
  toolCallId?: string;
}

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema for arguments */
  parameters?: unknown;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: unknown; strict?: boolean };

export interface AIRequestMetadata {
  app: string;
  userId?: string;
  userRole?: 'admin' | 'partner' | 'staff';
  engagementRef?: string;
  clientRef?: string;
}

export interface AIRequest {
  taskClass: string;
  messages: AIMessage[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream: boolean;
  /** model the app asked for (policy decides what is actually served) */
  modelRequested?: string;
  metadata: AIRequestMetadata;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';

export interface AIUsage {
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  /** true when the provider omitted usage and the router estimated it */
  estimated: boolean;
}

export interface AIResponse {
  message: { role: 'assistant'; content: string; toolCalls?: ToolCall[] };
  finishReason: FinishReason;
  usage: AIUsage;
  served: { model: string; providerId: string; latencyMs: number };
}

/** Internal streaming chunk format — adapters translate provider events into these. */
export type StreamChunk =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argumentsDelta: string }
  | { type: 'finish'; finishReason: FinishReason; usage?: AIUsage };

export const EMPTY_USAGE: AIUsage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  estimated: false,
};

// ── OpenAI-compatible request body → envelope (2.4) ─────────────────────────

const contentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string() }) }),
]);

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool', 'developer']),
  content: z.union([z.string(), z.array(contentPartSchema), z.null()]).optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({ name: z.string(), arguments: z.string() }),
      }),
    )
    .optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

export const openAiChatBodySchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(messageSchema).min(1),
    tools: z
      .array(
        z.object({
          type: z.literal('function'),
          function: z.object({
            name: z.string(),
            description: z.string().optional(),
            parameters: z.unknown().optional(),
            strict: z.boolean().nullish(),
          }),
        }),
      )
      .optional(),
    tool_choice: z
      .union([
        z.enum(['auto', 'none', 'required']),
        z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
      ])
      .optional(),
    response_format: z
      .union([
        z.object({ type: z.enum(['text', 'json_object']) }),
        z.object({
          type: z.literal('json_schema'),
          json_schema: z.object({
            name: z.string(),
            schema: z.unknown().optional(),
            strict: z.boolean().nullish(),
          }),
        }),
      ])
      .optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    user: z.string().optional(),
  })
  .passthrough();

export type OpenAiChatBody = z.infer<typeof openAiChatBodySchema>;

export interface EnvelopeLimits {
  maxMessages: number;
  maxJsonDepth: number;
}

export function jsonDepth(value: unknown, ceiling: number, depth = 0): number {
  if (depth > ceiling) return depth;
  if (Array.isArray(value)) {
    let max = depth + 1;
    for (const v of value) max = Math.max(max, jsonDepth(v, ceiling, depth + 1));
    return max;
  }
  if (value !== null && typeof value === 'object') {
    let max = depth + 1;
    for (const v of Object.values(value as Record<string, unknown>))
      max = Math.max(max, jsonDepth(v, ceiling, depth + 1));
    return max;
  }
  return depth;
}

export function toEnvelope(
  raw: unknown,
  taskClass: string,
  metadata: AIRequestMetadata,
  limits: EnvelopeLimits,
): AIRequest {
  // sanity caps BEFORE schema parse — depth bombs should die cheaply (2.9)
  const depth = jsonDepth(raw, limits.maxJsonDepth);
  if (depth > limits.maxJsonDepth) {
    throw new RouterError('invalid_request', `request JSON exceeds max depth ${limits.maxJsonDepth}`);
  }

  const parsed = openAiChatBodySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new RouterError('invalid_request', `invalid request body: ${first?.path.join('.')}: ${first?.message}`);
  }
  const body = parsed.data;

  if (body.messages.length > limits.maxMessages) {
    throw new RouterError('invalid_request', `too many messages (max ${limits.maxMessages})`);
  }

  const messages: AIMessage[] = body.messages.map((m) => {
    const role: Role = m.role === 'developer' ? 'system' : m.role;
    let content: string | ContentPart[];
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content))
      content = m.content.map((p): ContentPart => {
        if (p.type === 'text') return { type: 'text', text: p.text };
        return { type: 'image', url: p.image_url.url };
      });
    else content = '';
    const msg: AIMessage = { role, content };
    if (m.tool_calls)
      msg.toolCalls = m.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
    if (m.tool_call_id) msg.toolCallId = m.tool_call_id;
    return msg;
  });

  const env: AIRequest = {
    taskClass,
    messages,
    stream: body.stream ?? false,
    metadata,
  };
  if (body.tools)
    env.tools = body.tools.map((t) => ({
      name: t.function.name,
      ...(t.function.description !== undefined ? { description: t.function.description } : {}),
      ...(t.function.parameters !== undefined ? { parameters: t.function.parameters } : {}),
    }));
  if (body.tool_choice !== undefined)
    env.toolChoice =
      typeof body.tool_choice === 'string' ? body.tool_choice : { name: body.tool_choice.function.name };
  if (body.response_format) {
    if (body.response_format.type === 'json_schema') {
      env.responseFormat = {
        type: 'json_schema',
        name: body.response_format.json_schema.name,
        schema: body.response_format.json_schema.schema,
        ...(body.response_format.json_schema.strict != null
          ? { strict: body.response_format.json_schema.strict }
          : {}),
      };
    } else {
      env.responseFormat = { type: body.response_format.type };
    }
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens !== undefined) env.maxTokens = maxTokens;
  if (body.temperature !== undefined) env.temperature = body.temperature;
  if (body.top_p !== undefined) env.topP = body.top_p;
  if (body.stop !== undefined) env.stop = typeof body.stop === 'string' ? [body.stop] : body.stop;
  if (body.model !== undefined) env.modelRequested = body.model;
  return env;
}

// ── request hash (2.8) ───────────────────────────────────────────────────────

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

/** SHA-256 of canonicalized messages — the correlation key across logs/ledger/audit. */
export function requestHash(messages: AIMessage[]): string {
  return createHash('sha256').update(canonicalize(messages)).digest('hex');
}
