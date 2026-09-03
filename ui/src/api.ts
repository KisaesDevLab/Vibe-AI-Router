/** Thin fetch wrapper for /admin-api — mutations carry the x-vibe-admin CSRF header. */

/**
 * Where this bundle is mounted, as a path prefix with no trailing slash
 * (`''` at a hostname root, `'/ai-router'` under a path mount).
 *
 * Asset URLs are relative (see `base` in vite.config.ts), but API calls are
 * written as absolute paths — `/admin-api/auth/me` — and the browser sends
 * those to the ROOT of the host regardless of where the page came from. Under
 * a path mount that reaches whatever else lives at the root, so every request
 * fails in a way that looks like the API is down.
 *
 * Derived from `document.baseURI` rather than configured, so the same
 * container image works at a hostname root and under any prefix with no env
 * var, no build arg, and no entrypoint rewriting.
 *
 * Exported for testing.
 */
export function resolveMountPath(baseURI: string): string {
  let dir: string;
  try {
    // `new URL('.', …)` yields the directory of the current document, always
    // with a trailing slash. A page served at `/ai-router` (no slash) would
    // resolve to `/` — proxies redirect the bare form for exactly this
    // reason, and getting it wrong degrades to today's behaviour.
    dir = new URL('.', baseURI).pathname;
  } catch {
    return '';
  }
  return dir === '/' ? '' : dir.replace(/\/+$/, '');
}

/**
 * Read `document.baseURI` through `globalThis` rather than naming `document` directly. The
 * mount-path unit test imports this module, which pulls it into the SERVER type program — and
 * that one is deliberately `lib: ["ES2023"]` with no DOM, because server code has no business
 * touching browser globals. Naming `document` here fails that build (TS2584) even though the
 * value is guarded at runtime; going through globalThis keeps the guard and compiles in both
 * programs. Absent document (tests, SSR) → root-relative, which is the pre-mount behaviour.
 */
const doc = (globalThis as { document?: { baseURI?: string } }).document;
const MOUNT_PATH = doc?.baseURI === undefined ? '' : resolveMountPath(doc.baseURI);

/**
 * Absolute API paths get the mount prefix; anything else is left alone.
 *
 * Exported because file downloads (CSV, DOCX) are plain `<a href>`s rather than fetches — they
 * bypass `request()` entirely, so without this they would still resolve against the host root
 * under a path mount and fail exactly the way the console itself did.
 */
export function mounted(path: string): string {
  return path.startsWith('/') ? MOUNT_PATH + path : path;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(mounted(path), {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-vibe-admin': '1' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let code = 'unknown';
    let message = `HTTP ${res.status}`;
    let detail: Record<string, unknown> | undefined;
    try {
      const parsed = (await res.json()) as { error?: { code?: string; message?: string; detail?: Record<string, unknown> } };
      code = parsed.error?.code ?? code;
      message = parsed.error?.message ?? message;
      detail = parsed.error?.detail;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, code, message, detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// ── shared shapes (mirror admin-api responses) ──────────────────────────────

export interface Me {
  email: string;
  role: string;
  firm?: string;
}

export interface CredentialMeta {
  id: string;
  last4: string;
  status: 'active' | 'grace' | 'revoked';
  graceUntil: string | null;
  createdAt: string;
}

export interface Provider {
  id: string;
  kind: 'openai_compat' | 'anthropic' | 'local' | 'digitalocean' | 'local_ocr';
  label: string;
  baseUrl: string;
  authType: 'api_key' | 'none';
  status: 'unknown' | 'healthy' | 'degraded' | 'down';
  lastHealthAt: string | null;
  health: Record<string, unknown>;
  credentials: CredentialMeta[];
}

export interface Model {
  id: string;
  canonicalId: string;
  providerKind: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number | null;
  status: 'active' | 'deprecated' | 'sunset';
  source: 'synced' | 'custom' | 'provider';
  effective: Record<string, boolean>;
  pricing: { inputPerMtok: string | null; outputPerMtok: string | null } | null;
  /** the firm has a provider of this model's kind configured — i.e. it is routable today */
  configured: boolean;
  /** served by a third-party vendor through this kind (Claude/GPT on DigitalOcean) — Q-098 */
  thirdPartyHosted: boolean;
  retentionNote: string | null;
}

export interface ProbeResponse {
  results: {
    capability: 'vision' | 'json_schema' | 'tools';
    outcome: 'supported' | 'unsupported' | 'inconclusive';
    detail: string;
    latencyMs: number;
  }[];
  applied: boolean;
  overrides: Record<string, boolean>;
}

export interface ScrapeReport {
  scraped: number;
  matched: number;
  capabilitiesUpdated: string[];
  specsUpdated: string[];
  pricingChanged: string[];
  skippedCurated: string[];
  unmatched: number;
}

export interface TaskClass {
  id: string;
  key: string;
  app: string;
  description: string;
  sensitivity: 'local_only' | 'cloud_deidentified' | 'cloud_allowed';
  requires: Record<string, unknown>;
  defaultMaxTokens: number;
}

export interface PolicyView {
  taskClassKey: string;
  defaultModel: string;
  allowedModels: string[];
  fallbackChain: string[];
  maxTokensOverride: number | null;
  temperatureMin: number | null;
  temperatureMax: number | null;
  monthlyBudgetCents: number | null;
  enabled: boolean;
}

export interface PolicyExport {
  version: number;
  taskClasses: TaskClass[];
  policies: PolicyView[];
}

export interface SpendRow {
  dimension: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
  costCents: string;
  costUnknownCount: number;
}

export interface CostBreakdownRow {
  app: string;
  taskClass: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
  costCents: string;
  costUnknownCount: number;
  estimatedCount: number;
}

export interface DashboardHealth {
  providers: { id: string; label: string; kind: string; status: string; lastHealthAt: string | null; health: Record<string, unknown> }[];
  breakers: { providerId: string; state: string; errorRate: number; samples: number }[];
  budgets: {
    period: string;
    state: { scope: string; scopeRef: string; spentCents: string }[];
    settings: { firm_monthly_cents?: number; apps?: Record<string, number>; soft_pct?: number };
  };
  zeroCloud: boolean;
}

export interface AuditRow {
  id: string;
  ts: string;
  event: string;
  app: string | null;
  taskClass: string | null;
  model: string | null;
  provider: string | null;
  detail: Record<string, unknown>;
}

export function fmtCents(cents: string | number | null): string {
  if (cents === null) return '—';
  const n = typeof cents === 'string' ? Number(cents) : cents;
  return `$${(n / 100).toFixed(n >= 10000 ? 0 : 2)}`;
}

/**
 * Cost formatter that keeps sub-cent amounts legible. Per-request AI spend is often fractions
 * of a cent, and fmtCents's 2dp floor renders a whole column of real usage as "$0.00" — which
 * reads as "free" rather than "small". Precision widens as the amount shrinks.
 */
export function fmtCost(cents: string | number | null): string {
  if (cents === null) return '—';
  const dollars = (typeof cents === 'string' ? Number(cents) : cents) / 100;
  if (!Number.isFinite(dollars)) return '—';
  if (dollars === 0) return '$0';
  if (Math.abs(dollars) >= 100) return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (Math.abs(dollars) >= 1) return `$${dollars.toFixed(2)}`;
  if (Math.abs(dollars) >= 0.01) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(5)}`;
}

export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
