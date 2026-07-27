/**
 * Envelope → OpenAI-compatible wire shapes (responses only; request parsing lives in
 * envelope.ts). Clients speak OpenAI; the router speaks envelope internally.
 */
import type { AIResponse, AIUsage, FinishReason, StreamChunk } from './envelope.js';

interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
}

function toOpenAiUsage(u: AIUsage): OpenAiUsage {
  return {
    prompt_tokens: u.promptTokens,
    completion_tokens: u.completionTokens,
    total_tokens: u.promptTokens + u.completionTokens,
    ...(u.cachedReadTokens > 0 ? { prompt_tokens_details: { cached_tokens: u.cachedReadTokens } } : {}),
  };
}

const FINISH_MAP: Record<FinishReason, string> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  content_filter: 'content_filter',
  error: 'stop',
};

export function toChatCompletion(requestId: string, res: AIResponse): Record<string, unknown> {
  return {
    id: `chatcmpl-${requestId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: res.served.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: res.message.content || (res.message.toolCalls?.length ? null : ''),
          ...(res.message.toolCalls?.length
            ? {
                tool_calls: res.message.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              }
            : {}),
        },
        finish_reason: FINISH_MAP[res.finishReason],
        logprobs: null,
      },
    ],
    usage: toOpenAiUsage(res.usage),
    // router extension: served metadata (documented in docs/envelope.md)
    vibe: { provider_id: res.served.providerId, latency_ms: res.served.latencyMs },
  };
}

/** Translates one internal stream chunk into zero or more OpenAI `chat.completion.chunk` objects. */
export function toChunkObjects(
  requestId: string,
  model: string,
  chunk: StreamChunk,
  first: boolean,
): Record<string, unknown>[] {
  const base = {
    id: `chatcmpl-${requestId}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const roleDelta = first ? { role: 'assistant' as const } : {};
  switch (chunk.type) {
    case 'text_delta':
      return [
        {
          ...base,
          choices: [{ index: 0, delta: { ...roleDelta, content: chunk.delta }, finish_reason: null }],
        },
      ];
    case 'tool_call_start':
      return [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                ...roleDelta,
                tool_calls: [
                  {
                    index: chunk.index,
                    id: chunk.id,
                    type: 'function',
                    function: { name: chunk.name, arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
      ];
    case 'tool_call_delta':
      return [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: chunk.index, function: { arguments: chunk.argumentsDelta } }],
              },
              finish_reason: null,
            },
          ],
        },
      ];
    case 'finish': {
      const finishObj = {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: FINISH_MAP[chunk.finishReason] }],
      };
      if (chunk.usage) {
        return [finishObj, { ...base, choices: [], usage: toOpenAiUsage(chunk.usage) }];
      }
      return [finishObj];
    }
  }
}
