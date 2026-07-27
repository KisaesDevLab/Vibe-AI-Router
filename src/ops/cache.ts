/**
 * Optional response cache (13.2): opt-in per task class via `requires.cache_ttl_s`.
 * Key = request hash + canonical model. NON-STREAMING only. Local-tier only unless the task
 * class also sets `cache_cloud: true` (cloud responses stay uncached by default — cache reads
 * bypass the provider, and local answers are free anyway; the win is latency).
 * In-memory LRU with TTL — same single-container rationale as Q-038.
 */
import type { AIResponse } from '../gateway/envelope.js';

interface Entry {
  response: AIResponse;
  expiresAt: number;
}

export class ResponseCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly maxEntries = 1000) {}

  static key(requestHash: string, model: string): string {
    return `${model}:${requestHash}`;
  }

  get(key: string): AIResponse | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU touch
    this.entries.delete(key);
    this.entries.set(key, entry);
    // deep-ish copy so callers can't mutate the cached object
    return JSON.parse(JSON.stringify(entry.response)) as AIResponse;
  }

  set(key: string, response: AIResponse, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { response, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  get size(): number {
    return this.entries.size;
  }
}
