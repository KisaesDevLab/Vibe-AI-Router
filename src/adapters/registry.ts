/**
 * Adapter registry: provider kind → adapter singleton. `local` is the OpenAI-compat adapter
 * pointed at Ollama-style /v1 endpoints. `anthropic` arrives in Phase 4. `digitalocean`
 * (Gradient serverless inference) speaks the OpenAI wire protocol — same adapter, own kind,
 * because routing picks the firm's provider BY KIND and a second openai_compat row would be
 * unreachable next to OpenAI/Groq (Q-060).
 */
import type { AdapterRegistry } from '../gateway/pipeline.js';
import type { ProviderAdapter } from './contract.js';
import { OpenAiCompatAdapter } from './openai-compat/index.js';
import { AnthropicAdapter } from './anthropic/index.js';

export function createAdapterRegistry(): AdapterRegistry & {
  get(kind: string): ProviderAdapter | undefined;
} {
  const openaiCompat = new OpenAiCompatAdapter('openai_compat');
  const local = new OpenAiCompatAdapter('local');
  const byKind = new Map<string, ProviderAdapter>([
    ['openai_compat', openaiCompat],
    ['local', local],
    ['anthropic', new AnthropicAdapter()],
    ['digitalocean', new OpenAiCompatAdapter('digitalocean')],
    // GLM-OCR llama-server (R4/Q-075): OpenAI wire shape, LOCAL data tier, own kind so it
    // can coexist with the vibellm `local` row (routing resolves providers by kind)
    ['local_ocr', new OpenAiCompatAdapter('local_ocr')],
  ]);
  return {
    forKind: (kind) => byKind.get(kind),
    get: (kind) => byKind.get(kind),
  };
}
