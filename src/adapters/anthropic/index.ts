/**
 * Anthropic native adapter (Phase 4) — Messages API. Thin IO shell over translate.ts.
 */
import type {
  AdapterCapabilities,
  ConnectionTestResult,
  ProviderAdapter,
  TranslatedRequest,
} from '../contract.js';
import type { ExecuteContext } from '../../gateway/adapter-types.js';
import type { AIRequest, AIResponse, StreamChunk } from '../../gateway/envelope.js';
import { getJson, postJson, postSse } from '../http.js';
import { providerModelName } from '../openai-compat/translate.js';
import {
  AnthropicStreamState,
  buildAnthropicHeaders,
  buildAnthropicRequest,
  mapAnthropicError,
  parseStreamEvent,
  translateAnthropicResponse,
} from './translate.js';

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = 'anthropic';

  capabilities(): AdapterCapabilities {
    return {
      streaming: true,
      tools: true,
      jsonSchema: true, // via forced-tool mapping (Q-014)
      vision: true,
      promptCaching: true,
      reasoning: true,
    };
  }

  translateRequest(env: AIRequest, ctx: ExecuteContext): TranslatedRequest {
    const { body } = buildAnthropicRequest(env, ctx);
    return {
      url: `${ctx.baseUrl.replace(/\/+$/, '')}/v1/messages`,
      method: 'POST',
      headers: buildAnthropicHeaders(ctx),
      body,
    };
  }

  translateResponse(
    raw: unknown,
    meta: { model: string; providerId: string; latencyMs: number },
  ): AIResponse {
    return translateAnthropicResponse(raw, meta);
  }

  translateStreamChunk(raw: unknown): StreamChunk[] {
    // stateless best-effort translation; executeStream uses the stateful machine
    const event = parseStreamEvent(raw);
    if (!event) return [];
    return new AnthropicStreamState().handle(event);
  }

  async execute(env: AIRequest, ctx: ExecuteContext, signal: AbortSignal): Promise<AIResponse> {
    const { body, schemaTool } = buildAnthropicRequest({ ...env, stream: false }, ctx);
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/v1/messages`;
    const started = Date.now();
    try {
      const raw = await postJson(url, buildAnthropicHeaders(ctx), body, signal);
      return translateAnthropicResponse(
        raw,
        { model: ctx.model, providerId: ctx.providerId, latencyMs: Date.now() - started },
        schemaTool,
      );
    } catch (err) {
      throw mapAnthropicError(err);
    }
  }

  async *executeStream(env: AIRequest, ctx: ExecuteContext, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const { body, schemaTool } = buildAnthropicRequest({ ...env, stream: true }, ctx);
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/v1/messages`;
    const state = new AnthropicStreamState(schemaTool);
    try {
      for await (const data of postSse(url, buildAnthropicHeaders(ctx), body, signal)) {
        let raw: unknown;
        try {
          raw = JSON.parse(data);
        } catch {
          continue;
        }
        const event = parseStreamEvent(raw);
        if (!event) continue;
        yield* state.handle(event);
      }
    } catch (err) {
      throw mapAnthropicError(err);
    }
  }

  async testConnection(ctx: ExecuteContext, signal: AbortSignal): Promise<ConnectionTestResult> {
    const started = Date.now();
    const base = ctx.baseUrl.replace(/\/+$/, '');
    try {
      const model = providerModelName(ctx.model, ctx.modelMapping);
      if (!model) {
        // admin "Test connection" passes no model — a /v1/messages ping with model:"" is a
        // guaranteed 400, so validate auth/reachability via GET /v1/models instead
        const list = (await getJson(`${base}/v1/models?limit=20`, buildAnthropicHeaders(ctx), signal)) as {
          data?: unknown[];
        };
        return {
          ok: true,
          latencyMs: Date.now() - started,
          detail: Array.isArray(list.data) ? { modelCount: list.data.length } : {},
        };
      }
      await postJson(
        `${base}/v1/messages`,
        buildAnthropicHeaders(ctx),
        { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
        signal,
      );
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      const mapped = mapAnthropicError(err);
      return { ok: false, latencyMs: Date.now() - started, errorCode: mapped.code };
    }
  }
}
