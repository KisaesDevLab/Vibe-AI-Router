/**
 * Shared adapter HTTP plumbing: JSON POST with error surfacing, and incremental SSE parsing.
 * Raw provider error bodies are captured (truncated) for audit detail — message content never
 * appears in them by construction (they are provider ERROR payloads), but they are still
 * truncated and never logged verbatim at info level.
 */

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly bodyText: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, bodyText: string, retryAfterSeconds?: number) {
    super(`provider HTTP ${status}`);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.bodyText = bodyText.slice(0, 2000);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function parseRetryAfter(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs;
  const date = Date.parse(h);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.round((date - Date.now()) / 1000));
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new ProviderHttpError(res.status, await res.text().catch(() => ''), parseRetryAfter(res));
  }
  return res.json();
}

export async function getJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    throw new ProviderHttpError(res.status, await res.text().catch(() => ''), parseRetryAfter(res));
  }
  return res.json();
}

/**
 * POSTs and yields SSE `data:` payload strings incrementally. Handles multi-line data fields,
 * CRLF, and chunk boundaries splitting events.
 */
export async function* postSse(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new ProviderHttpError(res.status, await res.text().catch(() => ''), parseRetryAfter(res));
  }
  if (!res.body) throw new ProviderHttpError(502, 'no response body');

  const decoder = new TextDecoder();
  let buffer = '';
  const emit = function* (rawEvent: string): Generator<string> {
    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length > 0) yield dataLines.join('\n');
  };
  const reader = res.body.getReader();
  try {
    for (;;) {
      const result = (await reader.read()) as { done: boolean; value?: Uint8Array };
      if (result.done) {
        // flush any trailing multibyte bytes and emit a final event that arrived without a
        // trailing blank line (providers that close the socket right after the usage frame —
        // Q-077: losing it silently downgraded measured billing to estimated)
        buffer += decoder.decode();
        if (buffer.trim().length > 0) yield* emit(buffer);
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      // events are separated by a blank line
      for (;;) {
        const sep = buffer.search(/\r?\n\r?\n/);
        if (sep === -1) break;
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
        yield* emit(rawEvent);
      }
    }
  } finally {
    reader.releaseLock();
    // ensure the underlying stream is cancelled when the consumer stops early
    await res.body.cancel().catch(() => {});
  }
}
