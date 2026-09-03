/**
 * OpenAI-compatible adapter (3.2) — serves kinds `openai_compat` AND `local` (Ollama /v1).
 * All translation is pure (translate.ts); this file is the thin IO shell.
 */
import type {
  AdapterCapabilities,
  ConnectionTestResult,
  ProviderAdapter,
  TranslatedRequest,
} from '../contract.js';
import type { ExecuteContext } from '../../gateway/adapter-types.js';
import type { AIRequest, AIResponse, StreamChunk } from '../../gateway/envelope.js';
import { getJson, postJson, postSse, ProviderHttpError } from '../http.js';
import {
  buildHeaders,
  buildRequestBody,
  buildUrl,
  detectFlavor,
  estimateUsage,
  mapProviderError,
  OpenAiStreamState,
  providerModelName,
  translateResponse,
  translateStreamChunk,
} from './translate.js';

export class OpenAiCompatAdapter implements ProviderAdapter {
  readonly kind: 'openai_compat' | 'local' | 'digitalocean' | 'local_ocr';

  constructor(kind: 'openai_compat' | 'local' | 'digitalocean' | 'local_ocr' = 'openai_compat') {
    this.kind = kind;
  }

  /**
   * Static family capabilities. NOTE: nothing gates on this today — config-time and request-
   * time gating read the catalog row through `effectiveCapabilities()` (src/catalog/service.ts),
   * where `KIND_CAPABILITY_CEILING` is the enforced per-kind truth. Keep the two in agreement.
   */
  capabilities(): AdapterCapabilities {
    if (this.kind === 'local_ocr') {
      // GLM-OCR llama-server (R4/Q-097): transcription only — text + Markdown tables. No tool
      // calling, no structured output (a grammar constraint makes it hallucinate geometry
      // rather than refuse), and served as a single completion.
      return { streaming: false, tools: false, jsonSchema: false, vision: true, promptCaching: false, reasoning: false };
    }
    return {
      streaming: true,
      tools: true,
      jsonSchema: true,
      vision: true,
      promptCaching: false, // implicit on OpenAI, no cache_control surface
      reasoning: false,
    };
  }

  translateRequest(env: AIRequest, ctx: ExecuteContext): TranslatedRequest {
    const flavor = detectFlavor(ctx.baseUrl);
    const model = providerModelName(ctx.model, ctx.modelMapping);
    return {
      url: buildUrl(ctx, model, flavor),
      method: 'POST',
      headers: buildHeaders(ctx, flavor),
      body: buildRequestBody(env, model, flavor),
    };
  }

  translateResponse(
    raw: unknown,
    meta: { model: string; providerId: string; latencyMs: number },
  ): AIResponse {
    return translateResponse(raw, meta);
  }

  translateStreamChunk(raw: unknown): StreamChunk[] {
    return translateStreamChunk(raw);
  }

  async execute(env: AIRequest, ctx: ExecuteContext, signal: AbortSignal): Promise<AIResponse> {
    const req = this.translateRequest({ ...env, stream: false }, ctx);
    const started = Date.now();
    try {
      const raw = await postJson(req.url, req.headers, req.body, signal);
      const res = this.translateResponse(raw, {
        model: ctx.model,
        providerId: ctx.providerId,
        latencyMs: Date.now() - started,
      });
      if (res.usage.estimated) {
        // provider omitted usage — estimate rather than report zeros (3.6)
        res.usage = estimateUsage(env, res.message.content);
      }
      return res;
    } catch (err) {
      throw mapProviderError(err);
    }
  }

  async *executeStream(env: AIRequest, ctx: ExecuteContext, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const req = this.translateRequest({ ...env, stream: true }, ctx);
    let finishSeen: StreamChunk | undefined;
    let sawUsage = false;
    let textLength = 0;
    let collected = '';
    const state = new OpenAiStreamState(); // stateful: correct multi-tool + omitted-index handling
    try {
      for await (const data of postSse(req.url, req.headers, req.body, signal)) {
        if (data === '[DONE]') break;
        let raw: unknown;
        try {
          raw = JSON.parse(data);
        } catch {
          continue; // tolerate non-JSON keep-alives
        }
        for (const chunk of state.handle(raw)) {
          if (chunk.type === 'finish') {
            if (chunk.usage) {
              sawUsage = true;
              // merge usage into the finish we already saw (usage-only trailing chunk pattern)
              yield {
                type: 'finish',
                finishReason:
                  finishSeen?.type === 'finish' ? finishSeen.finishReason : chunk.finishReason,
                usage: chunk.usage,
              };
            } else {
              finishSeen = chunk; // hold; usage chunk may follow
            }
          } else {
            if (chunk.type === 'text_delta') {
              textLength += chunk.delta.length;
              collected += chunk.delta;
            }
            yield chunk;
          }
        }
      }
      if (!sawUsage) {
        const finishReason = finishSeen?.type === 'finish' ? finishSeen.finishReason : 'stop';
        yield {
          type: 'finish',
          finishReason,
          usage: estimateUsage(env, collected.slice(0, Math.max(textLength, 0))),
        };
      }
    } catch (err) {
      throw mapProviderError(err);
    }
  }

  async testConnection(ctx: ExecuteContext, signal: AbortSignal): Promise<ConnectionTestResult> {
    const flavor = detectFlavor(ctx.baseUrl);
    const headers = buildHeaders(ctx, flavor);
    const base = ctx.baseUrl.replace(/\/+$/, '');
    const started = Date.now();
    try {
      let modelCount: number | undefined;
      try {
        const list = (await getJson(`${base}/models`, headers, signal)) as { data?: unknown[] };
        modelCount = Array.isArray(list.data) ? list.data.length : undefined;
      } catch (err) {
        // some gateways don't expose /models — fall back to a 1-token completion (6.5)
        if (err instanceof ProviderHttpError && (err.status === 404 || err.status === 405)) {
          const model = providerModelName(ctx.model, ctx.modelMapping);
          // no model to ping with (admin test passes none) — surface the /models failure
          // honestly instead of a guaranteed-invalid empty-model completion
          if (!model) throw err;
          await postJson(
            buildUrl(ctx, model, flavor),
            headers,
            { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
            signal,
          );
        } else {
          throw err;
        }
      }

      const result: ConnectionTestResult = {
        ok: true,
        latencyMs: Date.now() - started,
        detail: modelCount !== undefined ? { modelCount } : {},
      };

      // Ollama capability probe (3.5): /api/show on the non-/v1 root
      if (flavor === 'ollama' && ctx.model) {
        const probe = await this.probeOllama(ctx, signal).catch(() => undefined);
        if (probe) result.probedCapabilities = probe;
      }
      return result;
    } catch (err) {
      const mapped = mapProviderError(err);
      return { ok: false, latencyMs: Date.now() - started, errorCode: mapped.code };
    }
  }

  private async probeOllama(
    ctx: ExecuteContext,
    signal: AbortSignal,
  ): Promise<ConnectionTestResult['probedCapabilities']> {
    const root = ctx.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    const model = providerModelName(ctx.model, ctx.modelMapping);
    const raw = (await postJson(`${root}/api/show`, {}, { model }, signal)) as {
      capabilities?: string[];
      model_info?: Record<string, unknown>;
    };
    const caps = raw.capabilities ?? [];
    const info = raw.model_info ?? {};
    const ctxKey = Object.keys(info).find((k) => k.endsWith('.context_length'));
    const contextWindow = ctxKey && typeof info[ctxKey] === 'number' ? (info[ctxKey] as number) : undefined;
    return {
      tools: caps.includes('tools'),
      vision: caps.includes('vision'),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
  }
}
