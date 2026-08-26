/**
 * Prometheus metrics (13.1). Scraped at GET /metrics — expose only on the internal docker
 * network (never routed through Caddy; see docs/appliance.md).
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { BreakerSnapshot } from '../resilience/breaker.js';

export class Metrics {
  readonly registry = new Registry();

  readonly requestsTotal = new Counter({
    name: 'vibe_router_requests_total',
    help: 'Completed requests by task class, provider, and terminal status',
    labelNames: ['task_class', 'provider', 'status'] as const,
    registers: [this.registry],
  });

  readonly requestDuration = new Histogram({
    name: 'vibe_router_request_duration_seconds',
    help: 'End-to-end request latency (successful requests)',
    labelNames: ['task_class', 'provider'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
    registers: [this.registry],
  });

  readonly scrubberBlocksTotal = new Counter({
    name: 'vibe_router_scrubber_blocks_total',
    help: 'Requests blocked by the data scrubber',
    labelNames: ['task_class'] as const,
    registers: [this.registry],
  });

  readonly budgetRejectionsTotal = new Counter({
    name: 'vibe_router_budget_rejections_total',
    help: 'Requests rejected by hard budget stops',
    labelNames: ['scope'] as const,
    registers: [this.registry],
  });

  readonly rateLimitedTotal = new Counter({
    name: 'vibe_router_rate_limited_total',
    help: 'Requests rejected by rate limiting',
    registers: [this.registry],
  });

  readonly fallbackHopsTotal = new Counter({
    name: 'vibe_router_fallback_hops_total',
    help: 'Fallback-chain advancements',
    registers: [this.registry],
  });

  readonly capabilityUpgradesTotal = new Counter({
    name: 'vibe_router_capability_upgrades_total',
    help: 'Capability-failing defaults upgraded to a capable configured model (Q-092)',
    registers: [this.registry],
  });

  readonly responsesRejectedTotal = new Counter({
    name: 'vibe_router_responses_rejected_total',
    help: 'Hops that answered 200 with an unusable result (see src/gateway/verify.ts)',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly cacheEvents = new Counter({
    name: 'vibe_router_response_cache_events_total',
    help: 'Response cache hits/misses (opt-in task classes only)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly breakerState = new Gauge({
    name: 'vibe_router_breaker_state',
    help: 'Circuit breaker state per provider (0 closed, 1 half-open, 2 open)',
    labelNames: ['provider_id'] as const,
    registers: [this.registry],
  });

  readonly catalogSyncAge = new Gauge({
    name: 'vibe_router_catalog_sync_age_seconds',
    help: 'Seconds since the last successful catalog sync',
    registers: [this.registry],
  });

  private lastSyncAt: number | undefined;

  constructor(breakerSnapshot?: () => BreakerSnapshot[]) {
    collectDefaultMetrics({ register: this.registry, prefix: 'vibe_router_' });
    if (breakerSnapshot) {
      // Refresh breaker gauges + sync age at scrape time.
      // `registers` is explicit: without it prom-client attaches the gauge to its GLOBAL
      // default registry, so constructing a second Metrics in one process threw
      // "already been registered" — which only showed up once the console and gateway roles
      // could both be built side by side.
      this.registry.registerMetric(
        new Gauge({
          name: 'vibe_router_breaker_refresh',
          help: 'internal scrape-time refresh hook (always 1)',
          registers: [this.registry],
          collect: () => {
            for (const snap of breakerSnapshot()) {
              this.breakerState.set(
                { provider_id: snap.providerId },
                snap.state === 'open' ? 2 : snap.state === 'half_open' ? 1 : 0,
              );
            }
            if (this.lastSyncAt !== undefined) {
              this.catalogSyncAge.set((Date.now() - this.lastSyncAt) / 1000);
            }
          },
        }),
      );
    }
  }

  markSync(): void {
    this.lastSyncAt = Date.now();
    this.catalogSyncAge.set(0);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
