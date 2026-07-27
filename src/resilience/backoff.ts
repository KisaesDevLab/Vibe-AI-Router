/** Retry backoff (10.1): exponential + full jitter, Retry-After wins, capped. */

export const MAX_RETRIES = 2;

export function retryDelayMs(attempt: number, retryAfterSeconds?: number, rand: () => number = Math.random): number {
  if (retryAfterSeconds !== undefined) return Math.min(retryAfterSeconds * 1000, 30_000);
  const base = 250 * 2 ** attempt; // 250, 500, 1000…
  return Math.min(base + rand() * 250, 4_000);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
