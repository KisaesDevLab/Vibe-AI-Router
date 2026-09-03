import { describe, expect, it } from 'vitest';
import { jsonDepth, requestHash, toEnvelope } from '../src/gateway/envelope.js';
import { RouterError } from '../src/gateway/errors.js';

const META = { app: 'vibe-tb' };
const LIMITS = { maxMessages: 200, maxJsonDepth: 24 };

describe('envelope translation (2.1/2.4)', () => {
  it('translates a plain chat body', () => {
    const env = toEnvelope(
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hello' },
        ],
        max_tokens: 100,
        temperature: 0.2,
        stream: false,
      },
      'tb_classification',
      META,
      LIMITS,
    );
    expect(env.taskClass).toBe('tb_classification');
    expect(env.messages).toHaveLength(2);
    expect(env.modelRequested).toBe('gpt-4o-mini');
    expect(env.maxTokens).toBe(100);
    expect(env.stream).toBe(false);
  });

  it('normalizes developer→system, max_completion_tokens wins, string stop → array', () => {
    const env = toEnvelope(
      {
        messages: [{ role: 'developer', content: 'rules' }],
        max_tokens: 5,
        max_completion_tokens: 9,
        stop: 'END',
      },
      'k',
      META,
      LIMITS,
    );
    expect(env.messages[0]?.role).toBe('system');
    expect(env.maxTokens).toBe(9);
    expect(env.stop).toEqual(['END']);
  });

  it('translates tools, tool_choice, tool messages and json_schema response_format', () => {
    const env = toEnvelope(
      {
        messages: [
          { role: 'user', content: 'x' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c1', content: '42' },
        ],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
        tool_choice: { type: 'function', function: { name: 'lookup' } },
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'out', schema: { type: 'object' }, strict: true, validation: 'strict' },
        },
      },
      'k',
      META,
      LIMITS,
    );
    expect(env.tools?.[0]?.name).toBe('lookup');
    expect(env.toolChoice).toEqual({ name: 'lookup' });
    expect(env.messages[1]?.toolCalls?.[0]).toEqual({ id: 'c1', name: 'lookup', arguments: '{"q":1}' });
    expect(env.messages[2]?.toolCallId).toBe('c1');
    expect(env.responseFormat).toEqual({
      type: 'json_schema',
      name: 'out',
      schema: { type: 'object' },
      strict: true,
      validation: 'strict',
    });
  });

  it('translates vision content parts', () => {
    const env = toEnvelope(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      },
      'k',
      META,
      LIMITS,
    );
    expect(env.messages[0]?.content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', url: 'data:image/png;base64,AAAA' },
    ]);
  });

  it('rejects: empty messages, too many messages, depth bombs (2.9)', () => {
    expect(() => toEnvelope({ messages: [] }, 'k', META, LIMITS)).toThrow(RouterError);
    expect(() =>
      toEnvelope(
        { messages: Array.from({ length: 5 }, () => ({ role: 'user', content: 'x' })) },
        'k',
        META,
        { ...LIMITS, maxMessages: 4 },
      ),
    ).toThrow(/too many messages/);

    let bomb: unknown = 'x';
    for (let i = 0; i < 40; i++) bomb = [bomb];
    expect(() =>
      toEnvelope({ messages: [{ role: 'user', content: 'x' }], extra: bomb }, 'k', META, LIMITS),
    ).toThrow(/max depth/);
  });

  it('invalid_request errors carry 400', () => {
    try {
      toEnvelope({ messages: 'nope' }, 'k', META, LIMITS);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RouterError);
      expect((e as RouterError).code).toBe('invalid_request');
      expect((e as RouterError).status).toBe(400);
    }
  });
});

describe('request hash (2.8)', () => {
  it('is stable under key order and differs on content', () => {
    const a = requestHash([{ role: 'user', content: 'hi' }]);
    const b = requestHash([{ content: 'hi', role: 'user' } as never]);
    const c = requestHash([{ role: 'user', content: 'bye' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('jsonDepth', () => {
  it('measures nested depth with a ceiling', () => {
    expect(jsonDepth('x', 10)).toBe(0);
    expect(jsonDepth({ a: { b: { c: 1 } } }, 10)).toBe(3);
    expect(jsonDepth([[[['x']]]], 10)).toBe(4);
  });
});
