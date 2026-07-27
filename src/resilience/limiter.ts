/**
 * Token-bucket rate limiting (10.6) per app-token and per user. In-memory (single-container
 * appliance); same-interface Redis store deferred (Q-038). 429 carries Retry-After.
 */
interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    /** sustained requests per minute */
    private readonly rpm: number,
    /** bucket capacity (burst); defaults to rpm/4, min 5 */
    private readonly burst = Math.max(5, Math.floor(rpm / 4)),
  ) {}

  /** returns undefined when admitted, else seconds to wait */
  take(key: string, now = Date.now()): number | undefined {
    if (this.rpm <= 0) return undefined; // 0 disables
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, updatedAt: now };
      this.buckets.set(key, b);
    }
    const refillPerMs = this.rpm / 60_000;
    b.tokens = Math.min(this.burst, b.tokens + (now - b.updatedAt) * refillPerMs);
    b.updatedAt = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return undefined;
    }
    return Math.ceil((1 - b.tokens) / refillPerMs / 1000);
  }

  /** periodic cleanup of idle buckets */
  prune(maxIdleMs = 600_000, now = Date.now()): void {
    for (const [k, b] of this.buckets) if (now - b.updatedAt > maxIdleMs) this.buckets.delete(k);
  }
}
