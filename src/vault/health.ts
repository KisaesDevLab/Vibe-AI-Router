/**
 * Provider health monitor (6.6): passive rolling error rate from live traffic, plus an
 * optional active probe interval. Status transitions are persisted on the provider row and
 * audited. In-memory state only — Redis is not required for correctness here.
 */
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { providers } from '../../db/schema.js';
import { writeAudit } from '../protect/audit.js';

type Status = 'unknown' | 'healthy' | 'degraded' | 'down';

interface Window {
  outcomes: boolean[]; // ring buffer, newest last
  status: Status;
}

const WINDOW_SIZE = 50;
const MIN_SAMPLES = 10;
const DOWN_THRESHOLD = 0.5;
const DEGRADED_THRESHOLD = 0.2;

export class HealthMonitor {
  private readonly windows = new Map<string, Window>();
  /** per-provider persist chain — transitions must land in order (test-caught race) */
  private readonly persistChains = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  /** Record a live-traffic outcome (passive monitoring). Never throws. */
  record(providerId: string, firmId: string, providerLabel: string, ok: boolean): void {
    const w = this.windows.get(providerId) ?? { outcomes: [], status: 'unknown' as Status };
    w.outcomes.push(ok);
    if (w.outcomes.length > WINDOW_SIZE) w.outcomes.shift();
    this.windows.set(providerId, w);

    const status = this.computeStatus(w);
    if (status !== w.status) {
      const from = w.status;
      w.status = status;
      const prev = this.persistChains.get(providerId) ?? Promise.resolve();
      const next = prev
        .then(() => this.persist(providerId, firmId, providerLabel, from, status, w))
        .catch((err: unknown) => {
          this.log.warn({ err, providerId }, 'health status persist failed');
        });
      this.persistChains.set(providerId, next);
    }
  }

  /** await outstanding persists (tests + graceful shutdown) */
  flush(): Promise<void> {
    return Promise.all(this.persistChains.values()).then(() => undefined);
  }

  errorRate(providerId: string): { rate: number; samples: number } {
    const w = this.windows.get(providerId);
    if (!w || w.outcomes.length === 0) return { rate: 0, samples: 0 };
    const failures = w.outcomes.filter((o) => !o).length;
    return { rate: failures / w.outcomes.length, samples: w.outcomes.length };
  }

  status(providerId: string): Status {
    return this.windows.get(providerId)?.status ?? 'unknown';
  }

  private computeStatus(w: Window): Status {
    if (w.outcomes.length < MIN_SAMPLES) return w.status; // not enough evidence to move
    const failures = w.outcomes.filter((o) => !o).length;
    const rate = failures / w.outcomes.length;
    if (rate >= DOWN_THRESHOLD) return 'down';
    if (rate >= DEGRADED_THRESHOLD) return 'degraded';
    return 'healthy';
  }

  private async persist(
    providerId: string,
    firmId: string,
    providerLabel: string,
    from: Status,
    to: Status,
    w: Window,
  ): Promise<void> {
    const failures = w.outcomes.filter((o) => !o).length;
    await this.db
      .update(providers)
      .set({ status: to, lastHealthAt: new Date() })
      .where(eq(providers.id, providerId));
    await writeAudit(this.db, {
      firmId,
      event: 'provider_health_changed',
      provider: providerLabel,
      detail: { from, to, errorRate: Number((failures / w.outcomes.length).toFixed(3)), samples: w.outcomes.length },
    });
    this.log.warn({ providerId, from, to }, 'provider health status changed');
  }
}
