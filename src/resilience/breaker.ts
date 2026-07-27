/**
 * Per-provider circuit breaker (10.2). In-memory implementation — correct for the
 * single-container appliance; a Redis-backed store can implement the same interface for
 * multi-instance deployments (Q-038). State surfaces to the health dashboard via snapshot().
 */
export type BreakerState = 'closed' | 'open' | 'half_open';

interface Window {
  outcomes: { ok: boolean; at: number }[];
  state: BreakerState;
  openedAt: number;
  halfOpenProbeInFlight: boolean;
}

export interface BreakerOptions {
  windowMs?: number;
  minSamples?: number;
  openThreshold?: number; // error rate
  openDurationMs?: number;
}

export interface BreakerSnapshot {
  providerId: string;
  state: BreakerState;
  errorRate: number;
  samples: number;
}

export class CircuitBreaker {
  private readonly windows = new Map<string, Window>();
  private readonly windowMs: number;
  private readonly minSamples: number;
  private readonly openThreshold: number;
  private readonly openDurationMs: number;
  /** transition hook for audit/health surfaces */
  onTransition?: (providerId: string, from: BreakerState, to: BreakerState, errorRate: number) => void;

  constructor(opts: BreakerOptions = {}) {
    this.windowMs = opts.windowMs ?? 30_000;
    this.minSamples = opts.minSamples ?? 10;
    this.openThreshold = opts.openThreshold ?? 0.5;
    this.openDurationMs = opts.openDurationMs ?? 30_000;
  }

  private window(providerId: string): Window {
    let w = this.windows.get(providerId);
    if (!w) {
      w = { outcomes: [], state: 'closed', openedAt: 0, halfOpenProbeInFlight: false };
      this.windows.set(providerId, w);
    }
    return w;
  }

  private prune(w: Window, now: number): void {
    const cutoff = now - this.windowMs;
    while (w.outcomes.length > 0 && w.outcomes[0]!.at < cutoff) w.outcomes.shift();
  }

  private errorRate(w: Window): number {
    if (w.outcomes.length === 0) return 0;
    return w.outcomes.filter((o) => !o.ok).length / w.outcomes.length;
  }

  /**
   * May this request proceed? open → false unless the open window elapsed, in which case ONE
   * half-open probe is admitted.
   */
  allow(providerId: string, now = Date.now()): boolean {
    const w = this.window(providerId);
    if (w.state === 'closed') return true;
    if (w.state === 'open') {
      if (now - w.openedAt >= this.openDurationMs) {
        this.transition(providerId, w, 'half_open');
        w.halfOpenProbeInFlight = true;
        return true;
      }
      return false;
    }
    // half_open: only the single probe
    if (!w.halfOpenProbeInFlight) {
      w.halfOpenProbeInFlight = true;
      return true;
    }
    return false;
  }

  record(providerId: string, ok: boolean, now = Date.now()): void {
    const w = this.window(providerId);
    w.outcomes.push({ ok, at: now });
    this.prune(w, now);

    if (w.state === 'half_open') {
      w.halfOpenProbeInFlight = false;
      if (ok) {
        w.outcomes = w.outcomes.filter((o) => o.ok); // fresh start
        this.transition(providerId, w, 'closed');
      } else {
        w.openedAt = now;
        this.transition(providerId, w, 'open');
      }
      return;
    }
    if (w.state === 'closed' && !ok) {
      // only a FAILURE may open the circuit — a fresh success never should, even when the
      // rolling window is still failure-heavy (chaos-test-caught)
      if (w.outcomes.length >= this.minSamples && this.errorRate(w) >= this.openThreshold) {
        w.openedAt = now;
        this.transition(providerId, w, 'open');
      }
    }
  }

  /** clear all windows (tests, admin reset) */
  reset(): void {
    this.windows.clear();
  }

  state(providerId: string): BreakerState {
    return this.window(providerId).state;
  }

  snapshot(): BreakerSnapshot[] {
    return [...this.windows.entries()].map(([providerId, w]) => ({
      providerId,
      state: w.state,
      errorRate: Number(this.errorRate(w).toFixed(3)),
      samples: w.outcomes.length,
    }));
  }

  private transition(providerId: string, w: Window, to: BreakerState): void {
    const from = w.state;
    if (from === to) return;
    w.state = to;
    this.onTransition?.(providerId, from, to, Number(this.errorRate(w).toFixed(3)));
  }
}
