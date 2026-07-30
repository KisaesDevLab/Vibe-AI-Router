/**
 * SSRF mitigation (14.2, threat T3): provider base_url validation.
 * - cloud kinds (openai_compat/anthropic): https only; hostname must not be loopback/private/
 *   link-local/metadata — checked by pattern here and by DNS resolution at config time, and
 *   re-checked by pattern at request time (toggle: SSRF_DENY_PRIVATE_CLOUD, default on).
 * - local kind: pinned the other way — host MUST be private/LAN/docker-DNS; a "local" provider
 *   pointing at a public host is a covert cloud route around the sensitivity tiers.
 */
import { lookup } from 'node:dns/promises';
import type { ProviderKind } from '../../db/schema.js';
import { isIP } from 'node:net';

export type HostClass = 'loopback' | 'private' | 'linklocal' | 'metadata' | 'dockerdns' | 'public';

function classifyIp(ip: string): HostClass {
  if (ip === '169.254.169.254') return 'metadata';
  if (/^127\.|^0\.0\.0\.0$/.test(ip) || ip === '::1') return 'loopback';
  if (/^10\.|^192\.168\./.test(ip)) return 'private';
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 'private';
  if (/^169\.254\./.test(ip)) return 'linklocal';
  const lower = ip.toLowerCase();
  if (lower.startsWith('fe80:')) return 'linklocal';
  if (/^f[cd]/.test(lower)) return 'private'; // fc00::/7
  if (lower.startsWith('::ffff:')) return classifyIp(lower.slice(7));
  return 'public';
}

export function classifyHost(hostname: string): HostClass {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return classifyIp(bare);
  const lower = bare.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return 'loopback';
  if (lower.endsWith('.local') || lower.endsWith('.internal') || lower.endsWith('.lan')) return 'private';
  if (!lower.includes('.')) return 'dockerdns'; // bare names resolve via docker's embedded DNS
  return 'public';
}

export interface SsrfVerdict {
  ok: boolean;
  reason?: string;
}

/** Pattern-level check — synchronous, used at request time and as the first config gate. */
export function checkBaseUrl(kind: ProviderKind, baseUrl: string): SsrfVerdict {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, reason: 'base_url is not a valid URL' };
  }
  const cls = classifyHost(url.hostname);
  if (kind === 'local') {
    if (cls === 'public') {
      return {
        ok: false,
        reason: 'local providers must point at a LAN/docker address — a public host would bypass the data boundary',
      };
    }
    if (cls === 'metadata') return { ok: false, reason: 'metadata endpoint is never a valid provider' };
    return { ok: true };
  }
  // cloud kinds
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'cloud providers require https' };
  }
  if (cls !== 'public') {
    return {
      ok: false,
      reason: `cloud provider base_url must be a public host (got ${cls}); use kind "local" for on-network gateways`,
    };
  }
  return { ok: true };
}

/**
 * Config-time deep check: also resolves DNS and rejects cloud URLs whose records point into
 * private space (DNS-rebinding-shaped configs die here, in front of an audit trail).
 */
export async function checkBaseUrlWithDns(
  kind: ProviderKind,
  baseUrl: string,
): Promise<SsrfVerdict> {
  const shallow = checkBaseUrl(kind, baseUrl);
  if (!shallow.ok || kind === 'local') return shallow;
  const hostname = new URL(baseUrl).hostname;
  if (isIP(hostname.replace(/^\[|\]$/g, ''))) return shallow; // literal already classified
  try {
    const records = await lookup(hostname, { all: true });
    for (const record of records) {
      const cls = classifyIp(record.address);
      if (cls !== 'public') {
        return { ok: false, reason: `cloud provider hostname resolves to a ${cls} address (${record.address})` };
      }
    }
  } catch {
    return { ok: false, reason: 'cloud provider hostname does not resolve' };
  }
  return { ok: true };
}
