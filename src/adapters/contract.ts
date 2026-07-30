/**
 * ProviderAdapter contract (3.1) — FROZEN, documented in docs/adapter-contract.md.
 * Adapters are the ONLY code that sees provider-specific shapes; everything else operates on
 * the internal envelope. Later phases extend, never break.
 */
import type { AIRequest, AIResponse, StreamChunk } from '../gateway/envelope.js';
import type { ExecuteContext, GatewayAdapter } from '../gateway/adapter-types.js';
import type { ProviderKind } from '../../db/schema.js';

export interface AdapterCapabilities {
  streaming: boolean;
  tools: boolean;
  jsonSchema: boolean;
  vision: boolean;
  promptCaching: boolean;
  reasoning: boolean;
}

/** Pure translation product — what execute() sends over the wire. Testable without IO. */
export interface TranslatedRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  /** taxonomy code when !ok */
  errorCode?: string;
  /** safe metadata only (model list size, discovered context length…) — never bodies/keys */
  detail?: Record<string, unknown>;
  /** capability probe outcome where the provider supports discovery (Ollama /api/show) */
  probedCapabilities?: Partial<AdapterCapabilities> & { contextWindow?: number };
}

export interface ProviderAdapter extends GatewayAdapter {
  readonly kind: ProviderKind;
  capabilities(): AdapterCapabilities;
  /** pure: envelope → wire request (url/headers/body). Secrets enter here and only here. */
  translateRequest(env: AIRequest, ctx: ExecuteContext): TranslatedRequest;
  /** pure: raw provider JSON → AIResponse (fixture-tested) */
  translateResponse(raw: unknown, meta: { model: string; providerId: string; latencyMs: number }): AIResponse;
  /** pure: one raw stream event payload → zero or more internal chunks (fixture-tested) */
  translateStreamChunk(raw: unknown): StreamChunk[];
  /** live minimal call; result stored on the provider record by the vault/health layer */
  testConnection(ctx: ExecuteContext, signal: AbortSignal): Promise<ConnectionTestResult>;
}
