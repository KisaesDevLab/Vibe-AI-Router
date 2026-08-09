/**
 * Anthropic adapter fixtures (4.7) + comparative envelope test (4.8).
 */
import { describe, expect, it } from 'vitest';
import {
  AnthropicStreamState,
  buildAnthropicHeaders,
  buildAnthropicRequest,
  mapAnthropicError,
  normalizeStopReason,
  parseStreamEvent,
  schemaToolName,
  translateAnthropicResponse,
} from '../src/adapters/anthropic/translate.js';
import { AnthropicAdapter } from '../src/adapters/anthropic/index.js';
import { OpenAiCompatAdapter } from '../src/adapters/openai-compat/index.js';
import { ProviderHttpError } from '../src/adapters/http.js';
import type { AIRequest, StreamChunk } from '../src/gateway/envelope.js';
import type { ExecuteContext } from '../src/gateway/adapter-types.js';

const CTX: ExecuteContext = {
  providerId: 'p-anthropic',
  model: 'anthropic/claude-sonnet-4-5',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-x',
};
const META = { model: CTX.model, providerId: CTX.providerId, latencyMs: 5 };

const ENV: AIRequest = {
  taskClass: 'k',
  messages: [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hello' },
  ],
  maxTokens: 128,
  stream: false,
  metadata: { app: 'vibe-tb' },
};

describe('request translation (4.1/4.5)', () => {
  it('extracts system, requires max_tokens, sets version header', () => {
    const { body } = buildAnthropicRequest(ENV, CTX);
    expect(body['system']).toEqual([{ type: 'text', text: 'be terse' }]);
    expect(body['max_tokens']).toBe(128);
    expect((body['messages'] as unknown[]).length).toBe(1);
    expect(buildAnthropicHeaders(CTX)).toEqual({
      'x-api-key': 'sk-ant-x',
      'anthropic-version': '2023-06-01',
    });
  });

  it('injects last-resort max_tokens when absent', () => {
    const env: AIRequest = { ...ENV };
    delete env.maxTokens;
    const { body } = buildAnthropicRequest(env, CTX);
    expect(body['max_tokens']).toBe(4096);
  });

  it('maps tool_calls → tool_use and tool results → tool_result (round trip, 4.7)', () => {
    const env: AIRequest = {
      ...ENV,
      messages: [
        { role: 'user', content: 'look up 42' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tu_1', name: 'lookup', arguments: '{"q":42}' }],
        },
        { role: 'tool', content: '{"answer":"found"}', toolCallId: 'tu_1' },
      ],
      tools: [{ name: 'lookup', description: 'look things up', parameters: { type: 'object' } }],
    };
    const { body } = buildAnthropicRequest(env, CTX);
    const messages = body['messages'] as Record<string, unknown>[];
    expect(messages[1]?.['content']).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 42 } },
    ]);
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"answer":"found"}' }],
    });
    expect((body['tools'] as unknown[])[0]).toMatchObject({ name: 'lookup', input_schema: { type: 'object' } });
  });

  it('tool_result with ARRAY content → block array, never JSON.stringify of internals (Q-078)', () => {
    const env: AIRequest = {
      ...ENV,
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'tool',
          content: [
            { type: 'text', text: '42' },
            { type: 'image', url: 'data:image/png;base64,AAAA' },
          ],
          toolCallId: 'tu_2',
        },
      ],
    };
    const messages = buildAnthropicRequest(env, CTX).body['messages'] as Record<string, unknown>[];
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_2',
          content: [
            { type: 'text', text: '42' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    });
  });

  it('temperature is clamped to Anthropic max 1.0 (ingress allows up to 2) (Q-078)', () => {
    const { body } = buildAnthropicRequest({ ...ENV, temperature: 1.7 }, CTX);
    expect(body['temperature']).toBe(1);
  });

  it('tool_use with missing input → arguments is "{}", never invalid JSON (Q-078)', () => {
    const res = translateAnthropicResponse(
      { content: [{ type: 'tool_use', id: 'tu_9', name: 'go' }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
      META,
    );
    expect(res.message.toolCalls?.[0]).toEqual({ id: 'tu_9', name: 'go', arguments: '{}' });
    const args = res.message.toolCalls![0]!.arguments;
    expect(() => {
      JSON.parse(args);
    }).not.toThrow();
  });

  it('maps images: data URI → base64 source, https → url source', () => {
    const env: AIRequest = {
      ...ENV,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', url: 'data:image/png;base64,QUJD' },
            { type: 'image', url: 'https://example.com/x.png' },
          ],
        },
      ],
    };
    const { body } = buildAnthropicRequest(env, CTX);
    const content = (body['messages'] as Record<string, unknown>[])[0]?.['content'] as Record<
      string,
      unknown
    >[];
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    });
    expect(content[2]).toEqual({ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } });
  });

  it('json_schema → forced synthetic tool; json_object → system instruction (Q-014)', () => {
    const env: AIRequest = {
      ...ENV,
      responseFormat: { type: 'json_schema', name: 'account', schema: { type: 'object' } },
    };
    const { body, schemaTool } = buildAnthropicRequest(env, CTX);
    expect(schemaTool).toBe(schemaToolName('account'));
    expect(body['tool_choice']).toEqual({ type: 'tool', name: schemaTool });

    const jsonEnv: AIRequest = { ...ENV, responseFormat: { type: 'json_object' } };
    const { body: jsonBody } = buildAnthropicRequest(jsonEnv, CTX);
    const system = jsonBody['system'] as { text: string }[];
    expect(system.some((s) => s.text.includes('valid JSON only'))).toBe(true);
  });

  it('cache_control breakpoints on system, tools, leading context when enabled (4.2)', () => {
    const env: AIRequest = {
      ...ENV,
      messages: [
        { role: 'system', content: 'big stable system prompt' },
        { role: 'user', content: 'stable context document' },
        { role: 'user', content: 'the actual question' },
      ],
      tools: [{ name: 't1' }, { name: 't2' }],
    };
    const { body } = buildAnthropicRequest(env, { ...CTX, promptCaching: true });
    const system = body['system'] as Record<string, unknown>[];
    expect(system[system.length - 1]?.['cache_control']).toEqual({ type: 'ephemeral' });
    const tools = body['tools'] as Record<string, unknown>[];
    expect(tools[tools.length - 1]?.['cache_control']).toEqual({ type: 'ephemeral' });
    expect(tools[0]?.['cache_control']).toBeUndefined();
    const messages = body['messages'] as { content: Record<string, unknown>[] }[];
    const leading = messages[messages.length - 2];
    expect(leading?.content[leading.content.length - 1]?.['cache_control']).toEqual({ type: 'ephemeral' });
    // OFF by default
    const { body: plain } = buildAnthropicRequest(env, CTX);
    expect((plain['system'] as Record<string, unknown>[])[0]?.['cache_control']).toBeUndefined();
  });

  it('4.7+/5-family models get adaptive thinking and no sampling params (Q-071)', () => {
    const ctx5 = { ...CTX, model: 'anthropic/claude-sonnet-5' };
    const env: AIRequest = { ...ENV, temperature: 0.3, topP: 0.9 };
    const { body } = buildAnthropicRequest(env, { ...ctx5, thinkingBudget: 2048 });
    expect(body['thinking']).toEqual({ type: 'adaptive' });
    expect(body['temperature']).toBeUndefined();
    expect(body['top_p']).toBeUndefined();
  });

  it('Claude 4.x gets temperature OR top_p, never both (Q-071)', () => {
    const env: AIRequest = { ...ENV, temperature: 0.3, topP: 0.9 };
    const { body } = buildAnthropicRequest(env, CTX);
    expect(body['temperature']).toBe(0.3);
    expect(body['top_p']).toBeUndefined();
    const envTopP: AIRequest = { ...ENV, topP: 0.9 };
    expect(buildAnthropicRequest(envTopP, CTX).body['top_p']).toBe(0.9);
  });

  it('thinking budget passthrough when task class enables it (4.3)', () => {
    const { body } = buildAnthropicRequest(ENV, { ...CTX, thinkingBudget: 2048 });
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 });
    const { body: off } = buildAnthropicRequest(ENV, CTX);
    expect(off['thinking']).toBeUndefined();
  });
});

describe('response translation + cache accounting (4.7)', () => {
  it('text response with cache read/write tokens in usage', () => {
    const res = translateAnthropicResponse(
      {
        content: [{ type: 'text', text: 'answer' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 9,
          cache_read_input_tokens: 60,
          cache_creation_input_tokens: 30,
        },
      },
      META,
    );
    expect(res.message.content).toBe('answer');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toEqual({
      promptTokens: 100,
      completionTokens: 9,
      cachedReadTokens: 60,
      cacheWriteTokens: 30,
      estimated: false,
    });
  });

  it('tool_use response → toolCalls with stringified arguments', () => {
    const res = translateAnthropicResponse(
      {
        content: [{ type: 'tool_use', id: 'tu_9', name: 'lookup', input: { q: 1 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      META,
    );
    expect(res.finishReason).toBe('tool_calls');
    expect(res.message.toolCalls).toEqual([{ id: 'tu_9', name: 'lookup', arguments: '{"q":1}' }]);
  });

  it('schema tool result becomes content, finish normalizes to stop (Q-014)', () => {
    const res = translateAnthropicResponse(
      {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'emit_account', input: { code: '6100' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      META,
      'emit_account',
    );
    expect(res.message.content).toBe('{"code":"6100"}');
    expect(res.message.toolCalls).toBeUndefined();
    expect(res.finishReason).toBe('stop');
  });

  it('thinking blocks surface on response, never in message content (4.3)', () => {
    const res = translateAnthropicResponse(
      {
        content: [
          { type: 'thinking', thinking: 'internal reasoning' },
          { type: 'text', text: 'visible answer' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      META,
    );
    expect(res.message.content).toBe('visible answer');
    expect(res.thinking).toBe('internal reasoning');
  });

  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool_calls'],
    ['refusal', 'content_filter'],
    ['pause_turn', 'stop'],
    [null, 'stop'],
  ])('stop_reason %s → %s', (raw, want) => {
    expect(normalizeStopReason(raw as string | null)).toBe(want);
  });
});

describe('streaming state machine (4.4)', () => {
  it('folds a full event sequence into internal chunks with usage', () => {
    const state = new AnthropicStreamState();
    const events = [
      {
        type: 'message_start',
        message: { usage: { input_tokens: 40, output_tokens: 0, cache_read_input_tokens: 16 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'f' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '1}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 17 } },
      { type: 'message_stop' },
    ];
    const chunks: StreamChunk[] = [];
    for (const e of events) {
      const parsed = parseStreamEvent(e);
      expect(parsed, JSON.stringify(e)).toBeDefined();
      chunks.push(...state.handle(parsed!));
    }
    expect(chunks).toEqual([
      { type: 'text_delta', delta: 'hel' },
      { type: 'text_delta', delta: 'lo' },
      { type: 'tool_call_start', index: 0, id: 'tu_1', name: 'f' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"a":' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '1}' },
      {
        type: 'finish',
        finishReason: 'tool_calls',
        usage: {
          promptTokens: 40,
          completionTokens: 17,
          cachedReadTokens: 16,
          cacheWriteTokens: 0,
          estimated: false,
        },
      },
    ]);
  });

  it('error event throws mapped RouterError; overloaded → provider_unavailable (4.6)', () => {
    const state = new AnthropicStreamState();
    const errEvent = parseStreamEvent({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    });
    expect(() => state.handle(errEvent!)).toThrow(/overloaded_error/);
    try {
      state.handle(errEvent!);
    } catch (e) {
      expect((e as { code: string }).code).toBe('provider_unavailable');
    }
  });
});

describe('error mapping (4.6)', () => {
  it.each([
    [401, '{"error":{"type":"authentication_error","message":"bad key"}}', 'auth_error'],
    [429, '{"error":{"type":"rate_limit_error","message":"slow down"}}', 'rate_limited'],
    [529, '{"error":{"type":"overloaded_error","message":"Overloaded"}}', 'provider_unavailable'],
    [400, '{"error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens"}}', 'context_exceeded'],
    [400, '{"error":{"type":"invalid_request_error","message":"tools: field required"}}', 'invalid_request'],
    [500, '{"error":{"type":"api_error","message":"boom"}}', 'provider_unavailable'],
  ])('HTTP %s %s → %s', (status, body, want) => {
    expect(mapAnthropicError(new ProviderHttpError(status as number, body as string)).code).toBe(want);
  });
});

describe('testConnection (6.5): admin test button passes no model', () => {
  it('empty model → GET /v1/models (auth check), never an empty-model /v1/messages ping', async () => {
    const { createServer } = await import('node:http');
    const seen: { method: string; url: string }[] = [];
    const server = createServer((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
        res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }] }));
      } else {
        res.end(
          JSON.stringify({
            content: [{ type: 'text', text: 'pong' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const adapter = new AnthropicAdapter();
    const signal = new AbortController().signal;

    // no model (vault.test default) → models listing, ok
    const noModel = await adapter.testConnection(
      { providerId: 'p', model: '', baseUrl: `http://127.0.0.1:${addr.port}`, apiKey: 'k' },
      signal,
    );
    expect(noModel.ok).toBe(true);
    expect(noModel.detail).toEqual({ modelCount: 2 });
    expect(seen).toEqual([{ method: 'GET', url: '/v1/models?limit=20' }]);

    // explicit model → 1-token /v1/messages ping (validates the model too)
    seen.length = 0;
    const withModel = await adapter.testConnection(
      {
        providerId: 'p',
        model: 'anthropic/claude-sonnet-4-5',
        baseUrl: `http://127.0.0.1:${addr.port}`,
        apiKey: 'k',
      },
      signal,
    );
    server.close();
    expect(withModel.ok).toBe(true);
    expect(seen).toEqual([{ method: 'POST', url: '/v1/messages' }]);
  });
});

describe('comparative test (4.8): identical envelope → structurally identical AIResponse', () => {
  it('both adapter families produce the same AIResponse for equivalent provider replies', async () => {
    const { createServer } = await import('node:http');
    // one mock server speaking both dialects
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url?.includes('/v1/messages')) {
          res.end(
            JSON.stringify({
              content: [{ type: 'text', text: 'same answer' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 11, output_tokens: 4 },
            }),
          );
        } else {
          res.end(
            JSON.stringify({
              choices: [{ message: { content: 'same answer' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 11, completion_tokens: 4 },
            }),
          );
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');

    const env: AIRequest = {
      taskClass: 'k',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'q' },
      ],
      maxTokens: 64,
      temperature: 0.1,
      stream: false,
      metadata: { app: 'vibe-tb' },
    };
    const signal = new AbortController().signal;
    const anthropic = await new AnthropicAdapter().execute(
      env,
      {
        providerId: 'p',
        model: 'anthropic/claude-sonnet-4-5',
        baseUrl: `http://127.0.0.1:${addr.port}`,
        apiKey: 'k',
      },
      signal,
    );
    const openai = await new OpenAiCompatAdapter().execute(
      env,
      {
        providerId: 'p',
        model: 'openai/gpt-4o-mini',
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        apiKey: 'k',
      },
      signal,
    );
    server.close();

    // structural identity: same keys, same message/finish/usage; served.model differs by design
    expect(Object.keys(anthropic).sort()).toEqual(Object.keys(openai).sort());
    expect(anthropic.message).toEqual(openai.message);
    expect(anthropic.finishReason).toBe(openai.finishReason);
    expect(anthropic.usage).toEqual(openai.usage);
  });
});
