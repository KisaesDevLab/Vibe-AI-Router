/** Thin fetch wrapper for /admin-api — mutations carry the x-vibe-admin CSRF header. */

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
  const res = await fetch(path, {
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
