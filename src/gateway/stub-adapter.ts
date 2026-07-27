/**
 * Stub adapter (Phase 2 acceptance vehicle): returns a deterministic response end-to-end so the
 * pipeline, streaming plumbing, and contract tests work before real adapters exist (Phase 3/4).
 * Kept permanently for chaos/e2e tests.
 */
import type { AIRequest, AIResponse, AIUsage, StreamChunk } from './envelope.js';
import type { ExecuteContext, GatewayAdapter } from './adapter-types.js';

function usageFor(env: AIRequest, completion: string): AIUsage {
  const promptChars = JSON.stringify(env.messages).length;
  return {
    promptTokens: Math.max(1, Math.round(promptChars / 4)),
    completionTokens: Math.max(1, Math.round(completion.length / 4)),
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    estimated: false,
  };
}

export class StubAdapter implements GatewayAdapter {
  readonly kind = 'stub';
  private readonly reply: string;

  constructor(reply = 'stub response from vibe-ai-router') {
    this.reply = reply;
  }

  execute(env: AIRequest, ctx: ExecuteContext, _signal: AbortSignal): Promise<AIResponse> {
    return Promise.resolve({
      message: { role: 'assistant', content: this.reply },
      finishReason: 'stop',
      usage: usageFor(env, this.reply),
      served: { model: ctx.model, providerId: ctx.providerId, latencyMs: 1 },
    });
  }

  async *executeStream(env: AIRequest, ctx: ExecuteContext, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const words = this.reply.split(' ');
    for (const [i, w] of words.entries()) {
      if (signal.aborted) return;
      await Promise.resolve(); // simulate async IO; also satisfies require-await
      yield { type: 'text_delta', delta: i === 0 ? w : ` ${w}` };
    }
    yield { type: 'finish', finishReason: 'stop', usage: usageFor(env, this.reply) };
    void ctx;
  }
}
