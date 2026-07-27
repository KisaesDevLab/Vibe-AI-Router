/**
 * Load-shed guard (10.7): per-provider concurrency semaphore with a bounded wait queue.
 * Queue full → reject immediately (rate_limited semantics, Retry-After 1).
 */
export class LoadShedGuard {
  private readonly inFlight = new Map<string, number>();
  private readonly queues = new Map<string, (() => void)[]>();

  constructor(
    private readonly maxConcurrent: number,
    private readonly queueCap: number,
  ) {}

  /** resolves with a release fn, or null when shed */
  acquire(providerId: string, signal?: AbortSignal): Promise<(() => void) | null> {
    const current = this.inFlight.get(providerId) ?? 0;
    if (current < this.maxConcurrent) {
      this.inFlight.set(providerId, current + 1);
      return Promise.resolve(() => this.release(providerId));
    }
    const queue = this.queues.get(providerId) ?? [];
    if (queue.length >= this.queueCap) return Promise.resolve(null);
    return new Promise((resolve) => {
      const entry = (): void => {
        this.inFlight.set(providerId, (this.inFlight.get(providerId) ?? 0) + 1);
        resolve(() => this.release(providerId));
      };
      queue.push(entry);
      this.queues.set(providerId, queue);
      signal?.addEventListener(
        'abort',
        () => {
          const idx = queue.indexOf(entry);
          if (idx !== -1) {
            queue.splice(idx, 1);
            resolve(null);
          }
        },
        { once: true },
      );
    });
  }

  private release(providerId: string): void {
    const current = (this.inFlight.get(providerId) ?? 1) - 1;
    this.inFlight.set(providerId, current);
    const queue = this.queues.get(providerId);
    if (queue && queue.length > 0 && current < this.maxConcurrent) {
      const next = queue.shift()!;
      next();
    }
  }

  stats(providerId: string): { inFlight: number; queued: number } {
    return {
      inFlight: this.inFlight.get(providerId) ?? 0,
      queued: this.queues.get(providerId)?.length ?? 0,
    };
  }
}
