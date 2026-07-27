/**
 * Minimal adapter surface the gateway consumes. Phase 3 freezes the full ProviderAdapter
 * contract (docs/adapter-contract.md) as an extension of this — the gateway-facing execute
 * shape defined here does not change.
 */
import type { AIRequest, AIResponse, StreamChunk } from './envelope.js';

export interface ExecuteContext {
  /** provider row id — threaded into AIResponse.served */
  providerId: string;
  /** canonical model id to serve */
  model: string;
  baseUrl: string;
  /** decrypted API key when the provider requires one; never logged */
  apiKey?: string;
  /** Azure-style deployment mapping and other provider quirks */
  modelMapping?: Record<string, string>;
  /** enable automatic cache_control breakpoints (Anthropic, 4.2) — set per task class */
  promptCaching?: boolean;
  /** extended-thinking budget tokens (Anthropic, 4.3) — set per task class */
  thinkingBudget?: number;
}

export interface GatewayAdapter {
  readonly kind: string;
  execute(env: AIRequest, ctx: ExecuteContext, signal: AbortSignal): Promise<AIResponse>;
  executeStream(env: AIRequest, ctx: ExecuteContext, signal: AbortSignal): AsyncIterable<StreamChunk>;
}
