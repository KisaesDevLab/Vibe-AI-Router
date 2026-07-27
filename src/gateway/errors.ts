/**
 * Normalized error taxonomy (2.3) — frozen contract, documented in docs/envelope.md.
 * Adapters map provider-specific failures into these codes at the edge; core logic and
 * clients only ever see this vocabulary.
 */
export const ERROR_CODES = [
  'invalid_request', // malformed body/headers (taxonomy extension, Q-008)
  'auth_error',
  'rate_limited',
  'provider_unavailable',
  'context_exceeded',
  'content_filtered',
  'policy_blocked',
  'scrubber_blocked',
  'capability_missing',
  'budget_exceeded',
  'unknown',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  auth_error: 401,
  rate_limited: 429,
  provider_unavailable: 502,
  context_exceeded: 400,
  content_filtered: 422,
  policy_blocked: 403,
  scrubber_blocked: 422,
  capability_missing: 400,
  budget_exceeded: 402,
  unknown: 500,
};

/** Codes a retry layer may legitimately retry (Phase 10 consumes this). */
export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set(['rate_limited', 'provider_unavailable']);

export class RouterError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** safe-for-client detail — must never contain message bodies or credential material */
  readonly detail: Record<string, unknown> | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { detail?: Record<string, unknown>; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code];
    this.detail = opts?.detail;
    this.retryAfterSeconds = opts?.retryAfterSeconds;
  }
}

/** OpenAI-compatible error body with our machine-readable `code`. */
export function errorBody(err: RouterError): {
  error: { message: string; type: string; code: ErrorCode; detail?: Record<string, unknown> };
} {
  return {
    error: {
      message: err.message,
      type: err.code === 'invalid_request' ? 'invalid_request_error' : 'router_error',
      code: err.code,
      ...(err.detail ? { detail: err.detail } : {}),
    },
  };
}

export function toRouterError(err: unknown): RouterError {
  if (err instanceof RouterError) return err;
  return new RouterError('unknown', err instanceof Error ? err.message : 'internal error');
}
