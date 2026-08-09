/**
 * Fixture-based adapter tests (3.9) — pure translation layer, no live keys, no network.
 */
import { describe, expect, it } from 'vitest';
import {
  buildHeaders,
  buildRequestBody,
  buildUrl,
  detectFlavor,
  estimateUsage,
  mapProviderError,
  normalizeFinishReason,
  providerModelName,
  translateResponse,
  OpenAiStreamState,
  translateStreamChunk,
} from '../src/adapters/openai-compat/translate.js';
import { ProviderHttpError } from '../src/adapters/http.js';
import { OpenAiCompatAdapter } from '../src/adapters/openai-compat/index.js';
import type { AIRequest } from '../src/gateway/envelope.js';
import type { ExecuteContext } from '../src/gateway/adapter-types.js';

const ENV: AIRequest = {
  taskClass: 'k',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
  metadata: { app: 'vibe-tb' },
};
const META = { model: 'openai/gpt-4o-mini', providerId: 'p1', latencyMs: 10 };

describe('flavor detection + URL/auth quirks (3.3/3.4)', () => {
  it('detects flavors from base URLs', () => {
    expect(detectFlavor('https://api.openai.com/v1')).toBe('openai');
    expect(detectFlavor('https://myres.openai.azure.com/openai?api-version=2024-06-01')).toBe('azure');
    expect(detectFlavor('http://vibellm:11434/v1')).toBe('ollama');
    expect(detectFlavor('http://localhost:11434/v1')).toBe('ollama');
    expect(detectFlavor('https://api.groq.com/openai/v1')).toBe('groq');
    expect(detectFlavor('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(detectFlavor('https://llm.internal.example/v1')).toBe('generic');
  });

  it('builds Azure deployment URL with api-version and api-key header', () => {
    const ctx: ExecuteContext = {
      providerId: 'p1',
      model: 'openai/gpt-4o-mini',
      baseUrl: 'https://myres.openai.azure.com/openai?api-version=2024-06-01',
      apiKey: 'azkey',
      modelMapping: { 'openai/gpt-4o-mini': 'my-4o-mini-deploy' },
    };
    const model = providerModelName(ctx.model, ctx.modelMapping);
    expect(model).toBe('my-4o-mini-deploy');
    const url = buildUrl(ctx, model, 'azure');
    expect(url).toBe(
      'https://myres.openai.azure.com/openai/deployments/my-4o-mini-deploy/chat/completions?api-version=2024-06-01',
    );
    expect(buildHeaders(ctx, 'azure')).toEqual({ 'api-key': 'azkey' });
  });

  it('standard URL + bearer for openai; no auth header for keyless local', () => {
    const ctx: ExecuteContext = {
      providerId: 'p1',
      model: 'ollama/qwen3:14b',
      baseUrl: 'http://vibellm:11434/v1',
    };
    expect(buildUrl(ctx, 'qwen3:14b', 'ollama')).toBe('http://vibellm:11434/v1/chat/completions');
    expect(buildHeaders(ctx, 'ollama')).toEqual({});
    expect(providerModelName('ollama/qwen3:14b')).toBe('qwen3:14b');
  });

  it('omits stream_options for ollama, includes it elsewhere (3.6)', () => {
    const streamEnv = { ...ENV, stream: true };
    expect(buildRequestBody(streamEnv, 'x', 'ollama')['stream_options']).toBeUndefined();
    expect(buildRequestBody(streamEnv, 'x', 'openai')['stream_options']).toEqual({ include_usage: true });
  });
});

describe('finish-reason normalization table (3.7)', () => {
  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['tool_calls', 'tool_calls'],
    ['function_call', 'tool_calls'],
    ['content_filter', 'content_filter'],
    ['eos', 'stop'],
    ['end_turn', 'stop'],
    ['max_tokens', 'length'],
    ['insufficient_system_resource', 'error'],
    [null, 'stop'],
    ['some_future_reason', 'stop'],
  ])('%s → %s', (raw, want) => {
    expect(normalizeFinishReason(raw as string | null)).toBe(want);
  });
});

describe('response translation fixtures', () => {
  it('openai completion with usage', () => {
    const res = translateResponse(
      {
        id: 'chatcmpl-1',
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } },
      },
      META,
    );
    expect(res.message.content).toBe('hello');
    // disjoint semantics (9.1): OpenAI prompt_tokens INCLUDES cached — adapter subtracts
    expect(res.usage).toEqual({
      promptTokens: 8,
      completionTokens: 3,
      cachedReadTokens: 4,
      cacheWriteTokens: 0,
      estimated: false,
    });
    expect(res.served).toEqual(META);
  });

  it('tool-call completion', () => {
    const res = translateResponse(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'c9', function: { name: 'lookup', arguments: '{"a":1}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
      META,
    );
    expect(res.finishReason).toBe('tool_calls');
    expect(res.message.toolCalls).toEqual([{ id: 'c9', name: 'lookup', arguments: '{"a":1}' }]);
  });

  it('deepseek cache-hit tokens land in cachedReadTokens', () => {
    const res = translateResponse(
      {
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 64 },
      },
      META,
    );
    expect(res.usage.cachedReadTokens).toBe(64);
    expect(res.usage.promptTokens).toBe(36); // 100 total − 64 cached (disjoint semantics)
  });

  it('ollama response without usage → estimated flag path', () => {
    const res = translateResponse(
      { choices: [{ message: { content: 'local reply' }, finish_reason: 'stop' }] },
      META,
    );
    expect(res.usage.estimated).toBe(true); // adapter replaces with estimateUsage()
  });

  it('malformed response → provider_unavailable', () => {
    expect(() => translateResponse({ nope: true }, META)).toThrow(/malformed provider response/);
  });
});

describe('stream chunk translation fixtures', () => {
  it('delta, tool-call frames, finish, trailing usage chunk', () => {
    expect(translateStreamChunk({ choices: [{ delta: { content: 'he' } }] })).toEqual([
      { type: 'text_delta', delta: 'he' },
    ]);
    expect(
      translateStreamChunk({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '' } }],
            },
          },
        ],
      }),
    ).toEqual([{ type: 'tool_call_start', index: 0, id: 'c1', name: 'f' }]);
    expect(
      translateStreamChunk({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x' } }] } }],
      }),
    ).toEqual([{ type: 'tool_call_delta', index: 0, argumentsDelta: '{"x' }]);
    expect(translateStreamChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })).toEqual([
      { type: 'finish', finishReason: 'stop' },
    ]);
    // usage-only trailing chunk (include_usage)
    const trailing = translateStreamChunk({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } });
    expect(trailing).toHaveLength(1);
    expect(trailing[0]).toMatchObject({ type: 'finish', usage: { promptTokens: 9, completionTokens: 4 } });
  });

  it('tolerates unknown shapes (returns [])', () => {
    expect(translateStreamChunk({ weird: true })).toEqual([]);
    expect(translateStreamChunk('noise')).toEqual([]);
  });

  // ── Q-078: stateful multi-tool + phantom-finish regressions ─────────────────
  it('OpenAiStreamState: two parallel tool calls that both OMIT index stay distinct', () => {
    const s = new OpenAiStreamState();
    // provider (Ollama /v1) omits index; names arrive on separate start frames
    const a = s.handle({ choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'f1', arguments: '' } }] } }] });
    const b = s.handle({ choices: [{ delta: { tool_calls: [{ id: 'b', function: { name: 'f2', arguments: '' } }] } }] });
    const argA = s.handle({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{"x":1}' } }] } }] });
    expect(a).toEqual([{ type: 'tool_call_start', index: 0, id: 'a', name: 'f1' }]);
    expect(b).toEqual([{ type: 'tool_call_start', index: 1, id: 'b', name: 'f2' }]);
    // arg-only frame with no index belongs to the most recently opened call (index 1)
    expect(argA).toEqual([{ type: 'tool_call_delta', index: 1, argumentsDelta: '{"x":1}' }]);
  });

  it('OpenAiStreamState: synthesizes an id when the provider sends name but no id', () => {
    const s = new OpenAiStreamState();
    expect(s.handle({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'g' } }] } }] })).toEqual([
      { type: 'tool_call_start', index: 0, id: 'call_0', name: 'g' },
    ]);
  });

  it('OpenAiStreamState: usage alongside CONTENT does not inject a phantom finish (vLLM cumulative usage)', () => {
    const s = new OpenAiStreamState();
    // a content chunk that also carries cumulative usage must NOT emit a finish
    const out = s.handle({ choices: [{ delta: { content: 'hi' }, finish_reason: null }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    expect(out).toEqual([{ type: 'text_delta', delta: 'hi' }]);
    expect(out.some((c) => c.type === 'finish')).toBe(false);
  });

  it('OpenAiStreamState: usage AND finish in one chunk (DeepSeek) attaches usage to the real finish', () => {
    const s = new OpenAiStreamState();
    const out = s.handle({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
    expect(out).toEqual([
      { type: 'finish', finishReason: 'tool_calls', usage: { promptTokens: 5, completionTokens: 2, cachedReadTokens: 0, cacheWriteTokens: 0, estimated: false } },
    ]);
  });
});

describe('error mapping (3.8)', () => {
  it.each([
    [401, '', 'auth_error'],
    [403, '', 'auth_error'],
    [429, '', 'rate_limited'],
    [400, '{"error":{"message":"This model\'s maximum context length is 8192"}}', 'context_exceeded'],
    [400, '{"error":{"code":"content_filter"}}', 'content_filtered'],
    [500, '', 'provider_unavailable'],
    [503, '', 'provider_unavailable'],
    [404, '', 'provider_unavailable'],
  ])('HTTP %s → %s', (status, body, want) => {
    const mapped = mapProviderError(new ProviderHttpError(status as number, body as string));
    expect(mapped.code).toBe(want);
  });

  it('retry-after survives mapping; network failure → provider_unavailable', () => {
    const mapped = mapProviderError(new ProviderHttpError(429, '', 7));
    expect(mapped.retryAfterSeconds).toBe(7);
    expect(mapProviderError(new TypeError('fetch failed')).code).toBe('provider_unavailable');
  });

  it('truncates provider body into detail', () => {
    const mapped = mapProviderError(new ProviderHttpError(500, 'x'.repeat(5000)));
    expect((mapped.detail?.['providerBody'] as string).length).toBeLessThanOrEqual(500);
  });
});

describe('estimateUsage (3.6)', () => {
  it('flags estimates and never returns zero prompt tokens', () => {
    const u = estimateUsage(ENV, 'four char text');
    expect(u.estimated).toBe(true);
    expect(u.promptTokens).toBeGreaterThan(0);
    expect(u.completionTokens).toBeGreaterThan(0);
  });
});

describe('adapter integration against a mock provider (3.9 harness)', () => {
  it('execute + executeStream against an in-process OpenAI-shaped server', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { stream?: boolean };
        if (parsed.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(
            'data: {"choices":[{"delta":{"content":"str"},"finish_reason":null}]}\n\n' +
              'data: {"choices":[{"delta":{"content":"eam"},"finish_reason":null}]}\n\n' +
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
              'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\n' +
              'data: [DONE]\n\n',
          );
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: 'mock reply' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 3, completion_tokens: 2 },
            }),
          );
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const ctx: ExecuteContext = {
      providerId: 'p1',
      model: 'openai/mock-model',
      baseUrl: `http://127.0.0.1:${addr.port}/v1`,
      apiKey: 'k',
    };
    const adapter = new OpenAiCompatAdapter();

    const res = await adapter.execute(ENV, ctx, new AbortController().signal);
    expect(res.message.content).toBe('mock reply');
    expect(res.usage.promptTokens).toBe(3);

    const chunks: string[] = [];
    let usageSeen = false;
    for await (const c of adapter.executeStream({ ...ENV, stream: true }, ctx, new AbortController().signal)) {
      if (c.type === 'text_delta') chunks.push(c.delta);
      if (c.type === 'finish' && c.usage) usageSeen = true;
    }
    expect(chunks.join('')).toBe('stream');
    expect(usageSeen).toBe(true);

    server.close();
  });
});
