/**
 * Provider catalog refresh (Q-101): one pass that pulls the current model list from every
 * linked DigitalOcean and Anthropic provider AND the pricing that goes with it. Runs nightly
 * (ahead of the vendored sync), whenever a provider connection is established (Q-085), and on
 * demand from the console.
 *
 *   models   DigitalOcean → GET /models (ids only)      Anthropic → GET /v1/models (ids + specs)
 *   pricing  DigitalOcean → docs.digitalocean.com scrape  Anthropic → live LiteLLM price feed
 *
 * Both pricing sources write to DISCOVERED rows only and never to an id the vendored feed
 * carries: the vendored snapshot remains the pinned source for what it lists (Q-017), and its
 * nightly sync would otherwise fight these writers one pricing row at a time.
 *
 * Best-effort throughout — a provider that errors, a docs page that moved, or an unreachable
 * price feed is reported and logged, and never blocks the other steps or the vendored sync.
 */
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { writeAudit } from '../protect/audit.js';
import { discoverProviderModels, DISCOVERABLE_KINDS, type DiscoverResult } from './discovery.js';
import {
  applyScrapedToCatalog,
  fetchDocsPage,
  scrapeDoDocs,
  type FetchPage,
  type ScrapeReport,
} from './do-docs.js';
import {
  applyLivePricing,
  fetchPricingFeed,
  type FetchPricingFeed,
  type LivePricingReport,
} from './live-pricing.js';
import { loadCuratedIds } from './sync.js';

export interface ProviderRefreshOptions {
  /** restrict to one firm's providers (console); absent → every firm (nightly) */
  firmId?: string;
  /** attributed on audit rows when an operator triggered the refresh */
  userId?: string;
  /** live price feed URL; absent or empty → the feed is not fetched */
  pricingFeedUrl?: string;
  fetchDocsPage?: FetchPage;
  fetchPricingFeed?: FetchPricingFeed;
  /** test seams for the live model lists */
  discover?: Parameters<typeof discoverProviderModels>[3];
}

export interface ProviderRefreshReport {
  providers: DiscoverResult[];
  failed: { providerLabel: string; reason: string }[];
  /** null → not run (no reachable DigitalOcean provider) or failed (see pricingErrors) */
  doDocs: ScrapeReport | null;
  /** null → not run (feed disabled, nothing to price) or failed (see pricingErrors) */
  livePricing: LivePricingReport | null;
  pricingErrors: string[];
}

const reasonOf = (err: unknown): string =>
  (err instanceof Error ? err.message : 'unknown error').slice(0, 200);

export async function refreshProviderCatalog(
  db: Db,
  log: Logger,
  getApiKey: (providerId: string) => Promise<string | undefined>,
  opts: ProviderRefreshOptions = {},
): Promise<ProviderRefreshReport> {
  const report: ProviderRefreshReport = {
    providers: [],
    failed: [],
    doDocs: null,
    livePricing: null,
    pricingErrors: [],
  };

  // Without the curated id set the pricing writers cannot tell which rows the vendored feed
  // owns — skip them rather than risk fighting the sync. Model lists still refresh.
  let curatedIds: Set<string> | undefined;
  try {
    curatedIds = await loadCuratedIds();
  } catch (err) {
    report.pricingErrors.push(`vendored feed unreadable; pricing refresh skipped (${reasonOf(err)})`);
  }

  const linked = await db.query.providers.findMany({
    where: (p, { and, eq, inArray, isNull }) =>
      and(
        inArray(p.kind, [...DISCOVERABLE_KINDS]),
        isNull(p.deletedAt),
        ...(opts.firmId ? [eq(p.firmId, opts.firmId)] : []),
      ),
  });
  const reachedKinds = new Set<string>();
  for (const provider of linked) {
    try {
      const apiKey = await getApiKey(provider.id);
      const result = await discoverProviderModels(db, provider, apiKey, {
        ...opts.discover,
        ...(curatedIds ? { curatedIds } : {}),
      });
      report.providers.push(result);
      reachedKinds.add(provider.kind);
      if (result.discovered.length > 0) {
        log.info(
          { provider: provider.label, discovered: result.discovered },
          'discovered new provider models',
        );
        await writeAudit(db, {
          firmId: provider.firmId,
          ...(opts.userId ? { userId: opts.userId } : {}),
          event: 'provider_models_discovered',
          detail: {
            providerId: provider.id,
            providerLabel: provider.label,
            discovered: result.discovered,
            alreadyKnown: result.alreadyKnown,
          },
        }).catch(() => {});
      }
    } catch (err) {
      log.warn({ err, provider: provider.label }, 'provider model discovery failed');
      report.failed.push({ providerLabel: provider.label, reason: reasonOf(err) });
    }
  }

  const auditFirmId = opts.firmId ?? linked[0]?.firmId;
  if (!curatedIds) return report;

  if (reachedKinds.has('digitalocean')) {
    try {
      const scraped = await scrapeDoDocs(opts.fetchDocsPage ?? fetchDocsPage, AbortSignal.timeout(30_000));
      const docs = await applyScrapedToCatalog(db, scraped, { curatedIds });
      report.doDocs = docs;
      const changed =
        docs.capabilitiesUpdated.length + docs.specsUpdated.length + docs.pricingChanged.length > 0;
      if (changed && auditFirmId) {
        await writeAudit(db, {
          firmId: auditFirmId,
          ...(opts.userId ? { userId: opts.userId } : {}),
          event: 'catalog_docs_scraped',
          detail: {
            source: 'docs.digitalocean.com',
            scraped: docs.scraped,
            matched: docs.matched,
            capabilitiesUpdated: docs.capabilitiesUpdated.length,
            specsUpdated: docs.specsUpdated.length,
            pricingChanged: docs.pricingChanged.length,
            skippedCurated: docs.skippedCurated.length,
            unmatched: docs.unmatched,
          },
        }).catch(() => {});
      }
    } catch (err) {
      log.warn({ err }, 'DigitalOcean docs pricing refresh failed');
      report.pricingErrors.push(`DigitalOcean docs: ${reasonOf(err)}`);
    }
  }

  if (reachedKinds.has('anthropic') && opts.pricingFeedUrl) {
    try {
      const text = await (opts.fetchPricingFeed ?? fetchPricingFeed)(
        opts.pricingFeedUrl,
        AbortSignal.timeout(30_000),
      );
      const live = await applyLivePricing(db, text, { curatedIds });
      report.livePricing = live;
      if (live.pricingChanged.length + live.specsUpdated.length > 0) {
        log.info(
          { pricingChanged: live.pricingChanged, specsUpdated: live.specsUpdated },
          'live pricing feed applied to discovered models',
        );
        if (auditFirmId) {
          await writeAudit(db, {
            firmId: auditFirmId,
            ...(opts.userId ? { userId: opts.userId } : {}),
            event: 'catalog_live_pricing_applied',
            detail: {
              source: opts.pricingFeedUrl.slice(0, 300),
              sourceSha256: live.sourceSha256,
              candidates: live.candidates,
              matched: live.matched,
              pricingChanged: live.pricingChanged.slice(0, 200),
              specsUpdated: live.specsUpdated.slice(0, 200),
            },
          }).catch(() => {});
        }
      }
    } catch (err) {
      log.warn({ err }, 'live pricing feed refresh failed');
      report.pricingErrors.push(`pricing feed: ${reasonOf(err)}`);
    }
  }

  return report;
}
