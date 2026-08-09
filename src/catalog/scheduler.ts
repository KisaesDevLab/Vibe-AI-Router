/**
 * Catalog jobs (5.6/5.7): nightly sync from the vendored feed + deprecation alerts.
 * Sync failures alert (log + audit) but NEVER block serving.
 */
import cron, { type ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { firms, taskClasses } from '../../db/schema.js';
import { writeAudit } from '../protect/audit.js';
import { loadVendoredFeed, syncCatalog, type DiffReport } from './sync.js';
import { findRetiredModelReferences } from './service.js';
import { runProviderDiscovery } from './discovery.js';

/** Live-endpoint model discovery (Q-082): supply a key resolver to enable it, omit to skip. */
export type GetApiKey = (providerId: string) => Promise<string | undefined>;

async function firmIdForAudit(db: Db): Promise<string | undefined> {
  const firm = await db.query.firms.findFirst({ orderBy: firms.createdAt });
  return firm?.id;
}

export async function runCatalogSync(
  db: Db,
  log: Logger,
  onSuccess?: () => void,
  getApiKey?: GetApiKey,
): Promise<DiffReport | undefined> {
  const firmId = await firmIdForAudit(db);
  // Live-provider discovery (Q-082) runs independently of the vendored sync's success — a
  // feed load failure must not suppress it, and its own failure must not fail the sync.
  if (getApiKey) {
    try {
      await runProviderDiscovery(db, log, getApiKey);
    } catch (err) {
      log.warn({ err }, 'provider model discovery pass failed');
    }
  }
  try {
    const { feed, sha256 } = await loadVendoredFeed();
    const report = await syncCatalog(db, feed, { source: 'vendored:litellm', sourceSha256: sha256 });
    log.info(
      {
        added: report.added.length,
        updated: report.updated.length,
        pricingChanged: report.pricingChanged.length,
        deprecated: report.deprecated.length,
        skipped: report.skipped.length,
      },
      'catalog sync completed',
    );
    if (firmId) {
      await writeAudit(db, {
        firmId,
        event: 'catalog_sync_completed',
        detail: {
          source: report.source,
          sourceSha256: report.sourceSha256,
          added: report.added.length,
          updated: report.updated.length,
          pricingChanged: report.pricingChanged.length,
          deprecated: report.deprecated.length,
          skipped: report.skipped.length,
          unchanged: report.unchanged,
        },
      });
    }
    await runDeprecationAlerts(db, log);
    onSuccess?.();
    return report;
  } catch (err) {
    // alert, never block serving (5.6)
    log.error({ err }, 'catalog sync failed');
    if (firmId) {
      await writeAudit(db, {
        firmId,
        event: 'catalog_sync_failed',
        detail: {
          source: 'vendored:litellm',
          reason: (err instanceof Error ? err.message : 'unknown').slice(0, 500),
        },
      }).catch(() => {});
    }
    return undefined;
  }
}

export async function runDeprecationAlerts(db: Db, log: Logger): Promise<number> {
  const refs = await findRetiredModelReferences(db);
  for (const ref of refs) {
    const tc = await db.query.taskClasses.findFirst({ where: eq(taskClasses.id, ref.taskClassId) });
    await writeAudit(db, {
      firmId: ref.firmId,
      event: 'model_deprecation_warning',
      taskClass: tc?.key ?? ref.taskClassId,
      model: ref.canonicalId,
      detail: {
        policyId: ref.policyId,
        taskClass: tc?.key ?? ref.taskClassId,
        modelCanonicalId: ref.canonicalId,
        modelStatus: ref.status,
        role: ref.role,
      },
    });
  }
  if (refs.length > 0) log.warn({ count: refs.length }, 'policies reference deprecated/sunset models');
  return refs.length;
}

export function startCatalogScheduler(
  db: Db,
  log: Logger,
  cronExpr: string,
  onSuccess?: () => void,
  getApiKey?: GetApiKey,
): ScheduledTask {
  const task = cron.schedule(cronExpr, () => {
    void runCatalogSync(db, log, onSuccess, getApiKey);
  });
  log.info({ cron: cronExpr }, 'catalog sync scheduled');
  return task;
}
