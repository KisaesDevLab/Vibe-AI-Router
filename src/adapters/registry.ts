/**
 * Adapter registry: provider kind → adapter singleton. `local` is the OpenAI-compat adapter
 * pointed at Ollama-style /v1 endpoints. `anthropic` arrives in Phase 4.
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
  ]);
  return {
    forKind: (kind) => byKind.get(kind),
    get: (kind) => byKind.get(kind),
  };
}
