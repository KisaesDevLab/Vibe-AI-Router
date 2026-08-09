/**
 * SDK completeJson unit tests (sdk-v0.2.1): the max_tokens truncation check. Pure — no DB, no
 * router; the SDK's `fetch` override returns a canned wire completion so we can drive
 * finish_reason directly. Guards both truncation failure modes (silent-partial + misleading
 * "not valid JSON") and confirms the untruncated paths are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { VibeAiClient, VibeAiError } from '../packages/sdk/src/index.js';

/** Build a stubbed fetch returning one canned /v1/chat/completions wire body. */
function stubFetch(opts: {
  content: string | null;
  finishReason: string;
  completionTokens?: number;
  toolCalls?: { id: string; function: { name: string; arguments: string } }[];
}): typeof fetch {
  const wire = {
    model: 'ollama/qwen3:14b',
    choices: [
      {
        message: { content: opts.content, ...(opts.toolCalls ? { tool_calls: opts.toolCalls } : {}) },
        finish_reason: opts.finishReason,
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: opts.completionTokens ?? 7 },
  };
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(wire), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_test_123' },
      }),
    )) as unknown as typeof fetch;
}

const SCHEMA = { name: 'loan_fields', schema: { type: 'object' } };
const client = (fetchFn: typeof fetch): VibeAiClient =>
  new VibeAiClient({ baseUrl: 'http://router.test', token: 't', fetch: fetchFn });

describe('completeJson truncation check (Q-078 downstream / sdk-v0.2.1)', () => {
  it('finish_reason length + PARSEABLE content → output_truncated (not silent success)', async () => {
    const c = client(stubFetch({ content: '{"x":1}', finishReason: 'length', completionTokens: 9 }));
    await expect(c.completeJson('tb', [{ role: 'user', content: 'go' }], SCHEMA)).rejects.toMatchObject({
      name: 'VibeAiError',
      code: 'output_truncated',
      retryable: false,
    });
    // message carries the SERVED completion count; detail carries requestId + count
    try {
      await c.completeJson('tb', [{ role: 'user', content: 'go' }], SCHEMA);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as VibeAiError;
      expect(err).toBeInstanceOf(VibeAiError);
      expect(err.message).toContain('9');
      expect(err.detail).toMatchObject({ requestId: 'req_test_123', completionTokens: 9 });
    }
  });

  it('finish_reason length + NON-parseable content → still output_truncated (ordering)', async () => {
    const c = client(stubFetch({ content: '{"x":', finishReason: 'length', completionTokens: 4 }));
    await expect(c.completeJson('tb', [{ role: 'user', content: 'go' }], SCHEMA)).rejects.toMatchObject({
      code: 'output_truncated',
    });
  });

  it('finish_reason stop + fenced JSON → returns parsed data (unchanged)', async () => {
    const c = client(stubFetch({ content: '```json\n{"x":1}\n```', finishReason: 'stop' }));
    const res = await c.completeJson<{ x: number }>('tb', [{ role: 'user', content: 'go' }], SCHEMA);
    expect(res.data).toEqual({ x: 1 });
    expect(res.finishReason).toBe('stop');
  });

  it('finish_reason stop + tool-call answer (no content) → returns parsed data (unchanged)', async () => {
    const c = client(
      stubFetch({
        content: null,
        finishReason: 'stop',
        toolCalls: [{ id: 'c1', function: { name: 'emit_loan_fields', arguments: '{"x":2}' } }],
      }),
    );
    const res = await c.completeJson<{ x: number }>('tb', [{ role: 'user', content: 'go' }], SCHEMA);
    expect(res.data).toEqual({ x: 2 });
  });

  it('finish_reason stop + un-parseable content → unknown (not output_truncated)', async () => {
    const c = client(stubFetch({ content: 'not json at all', finishReason: 'stop' }));
    await expect(c.completeJson('tb', [{ role: 'user', content: 'go' }], SCHEMA)).rejects.toMatchObject({
      code: 'unknown',
    });
  });
});
