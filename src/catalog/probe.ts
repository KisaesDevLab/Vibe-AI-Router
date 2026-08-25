/**
 * Active capability probing (Q-089): send tiny SYNTHETIC requests through a provider adapter
 * to determine whether a model actually supports vision / json_schema / tools. Discovered
 * DigitalOcean models arrive with conservative capabilities (Q-082/Q-083 — DO's /models
 * endpoint reports ids only, and its capability docs are human-readable HTML), leaving the
 * operator to "enable after verifying"; a probe automates the verifying.
 *
 * These calls deliberately bypass the request pipeline: the probe bodies below are the entire
 * content (a 1×1 transparent PNG and fixed strings), so there is no firm data for policy or
 * the scrubber to protect and nothing to bill a task class for. Probes are operator-triggered
 * only — results land in capability OVERRIDES (which win over synced values and survive
 * re-sync, 5.5), and only CONCLUSIVE outcomes are applied: transient failures (auth, rate
 * limit, network, 5xx) never flip a capability either way.
 */
import { RouterError } from '../gateway/errors.js';
import type { AIRequest, AIResponse } from '../gateway/envelope.js';
import type { ExecuteContext, GatewayAdapter } from '../gateway/adapter-types.js';

export const PROBEABLE_CAPABILITIES = ['vision', 'json_schema', 'tools'] as const;
export type ProbeableCapability = (typeof PROBEABLE_CAPABILITIES)[number];

export type ProbeOutcome = 'supported' | 'unsupported' | 'inconclusive';

export interface ProbeResult {
  capability: ProbeableCapability;
  outcome: ProbeOutcome;
  /** short human-readable reason for the verdict — safe metadata only, never response bodies */
  detail: string;
  latencyMs: number;
}

/** 1×1 transparent PNG — the entire "document" a vision probe sends. */
export const PROBE_IMAGE_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PROBE_METADATA = { app: 'router-admin' } as const;

/** Pure: the synthetic envelope for one capability probe. */
export function buildProbeRequest(capability: ProbeableCapability): AIRequest {
  const base = {
    taskClass: '__capability_probe__',
    stream: false as const,
    maxTokens: 64,
    temperature: 0,
    metadata: PROBE_METADATA,
  };
  switch (capability) {
    case 'vision':
      return {
        ...base,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Reply with the single word OK.' },
              { type: 'image', url: PROBE_IMAGE_DATA_URI },
            ],
          },
        ],
      };
    case 'json_schema':
      return {
        ...base,
        messages: [{ role: 'user', content: 'Return the JSON object {"ok": true}.' }],
        responseFormat: {
          type: 'json_schema',
          name: 'probe',
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
          strict: true,
        },
      };
    case 'tools':
      return {
        ...base,
        messages: [{ role: 'user', content: 'Call the ping tool.' }],
        tools: [
          {
            name: 'ping',
            description: 'Reports that tool calling works.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
        toolChoice: 'required',
      };
  }
}

/**
 * Pure: a COMPLETED response → verdict. A 200 is only "supported" when the response actually
 * exercised the capability — providers that don't implement response_format or tool_choice
 * often ignore them silently rather than erroring.
 */
export function classifyProbeSuccess(capability: ProbeableCapability, res: AIResponse): ProbeResult['outcome'] {
  switch (capability) {
    case 'vision':
      return 'supported'; // non-vision endpoints reject image parts; accepting one is the signal
    case 'json_schema': {
      try {
        const parsed: unknown = JSON.parse(res.message.content);
        return parsed !== null && typeof parsed === 'object' ? 'supported' : 'inconclusive';
      } catch {
        return 'inconclusive'; // format likely ignored, but "model chatted" is not proof of absence
      }
    }
    case 'tools':
      return (res.message.toolCalls?.length ?? 0) > 0 ? 'supported' : 'inconclusive';
  }
}

/**
 * Pure: a FAILED probe → verdict. Only a definitive request-level rejection (HTTP 400/415/422
 * that isn't a context/content-filter mapping) is "unsupported"; auth, rate limits, timeouts,
 * missing endpoints (404), and 5xx say nothing about the model.
 */
export function classifyProbeError(err: unknown): { outcome: ProbeOutcome; detail: string } {
  if (err instanceof RouterError) {
    const status = typeof err.detail?.['providerStatus'] === 'number' ? err.detail['providerStatus'] : undefined;
    if (err.code === 'auth_error' || err.code === 'rate_limited') {
      return { outcome: 'inconclusive', detail: `provider ${err.code} — fix and re-probe` };
    }
    if (
      (status === 400 || status === 415 || status === 422) &&
      err.code !== 'context_exceeded' &&
      err.code !== 'content_filtered'
    ) {
      return { outcome: 'unsupported', detail: `provider rejected the request (HTTP ${status})` };
    }
    return { outcome: 'inconclusive', detail: `${err.code}${status !== undefined ? ` (HTTP ${status})` : ''}` };
  }
  return { outcome: 'inconclusive', detail: err instanceof Error ? err.name : 'unknown error' };
}

export interface ProbeOptions {
  capabilities?: readonly ProbeableCapability[];
  /** per-probe timeout; probes run sequentially to avoid tripping provider rate limits */
  timeoutMs?: number;
}

export async function probeModelCapabilities(
  adapter: GatewayAdapter,
  ctx: ExecuteContext,
  opts?: ProbeOptions,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const capability of opts?.capabilities ?? PROBEABLE_CAPABILITIES) {
    const started = Date.now();
    try {
      const res = await adapter.execute(
        buildProbeRequest(capability),
        ctx,
        AbortSignal.timeout(opts?.timeoutMs ?? 20_000),
      );
      results.push({
        capability,
        outcome: classifyProbeSuccess(capability, res),
        detail: `completed (finish=${res.finishReason})`,
        latencyMs: Date.now() - started,
      });
    } catch (err) {
      const { outcome, detail } = classifyProbeError(err);
      results.push({ capability, outcome, detail, latencyMs: Date.now() - started });
    }
  }
  return results;
}

/**
 * Pure: merge CONCLUSIVE probe outcomes into the model's existing capability overrides.
 * Inconclusive probes leave whatever the operator (or a previous probe) set untouched.
 */
export function overridesFromProbes(
  existing: Record<string, boolean>,
  results: ProbeResult[],
): Record<string, boolean> {
  const merged = { ...existing };
  for (const r of results) {
    if (r.outcome === 'supported') merged[r.capability] = true;
    else if (r.outcome === 'unsupported') merged[r.capability] = false;
  }
  return merged;
}
