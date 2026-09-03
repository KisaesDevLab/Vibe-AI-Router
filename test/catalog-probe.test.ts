/**
 * Capability probe (Q-089): pure builders/classifiers + the sequential probe loop with a fake
 * adapter. The safety property under test: only CONCLUSIVE outcomes ever change an override —
 * auth failures, rate limits, timeouts, and ambiguous 200s leave capabilities untouched.
 */
import { describe, expect, it } from 'vitest';
import { RouterError } from '../src/gateway/errors.js';
import { EMPTY_USAGE, type AIResponse } from '../src/gateway/envelope.js';
import type { GatewayAdapter } from '../src/gateway/adapter-types.js';
import {
  buildProbeRequest,
  ceilingCappedCapabilities,
  classifyProbeError,
  classifyProbeSuccess,
  overridesFromProbes,
  probeModelCapabilities,
  PROBE_IMAGE_DATA_URI,
} from '../src/catalog/probe.js';

const response = (content: string, toolCalls?: { id: string; name: string; arguments: string }[]): AIResponse => ({
  message: { role: 'assistant', content, ...(toolCalls ? { toolCalls } : {}) },
  finishReason: 'stop',
  usage: EMPTY_USAGE,
  served: { model: 'm', providerId: 'p', latencyMs: 1 },
});

describe('buildProbeRequest', () => {
  it('vision probe carries exactly one synthetic image and no other content', () => {
    const req = buildProbeRequest('vision');
    const content = req.messages[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as { type: string; url?: string }[];
    expect(parts.filter((p) => p.type === 'image')).toHaveLength(1);
    expect(parts.find((p) => p.type === 'image')?.url).toBe(PROBE_IMAGE_DATA_URI);
    expect(req.maxTokens).toBe(64);
    expect(req.stream).toBe(false);
  });

  it('json_schema probe requests a strict schema; tools probe forces a tool call', () => {
    expect(buildProbeRequest('json_schema').responseFormat).toMatchObject({ type: 'json_schema', strict: true });
    const tools = buildProbeRequest('tools');
    expect(tools.tools).toHaveLength(1);
    expect(tools.toolChoice).toBe('required');
  });
});

describe('classifyProbeSuccess', () => {
  it('vision: any completion counts (non-vision endpoints reject image parts)', () => {
    expect(classifyProbeSuccess('vision', response('OK'))).toBe('supported');
  });

  it('json_schema: only a parseable JSON object proves enforcement', () => {
    expect(classifyProbeSuccess('json_schema', response('{"ok":true}'))).toBe('supported');
    // provider silently ignored response_format → NOT proof either way
    expect(classifyProbeSuccess('json_schema', response('Sure! Here is your JSON: ok'))).toBe('inconclusive');
    expect(classifyProbeSuccess('json_schema', response('"just a string"'))).toBe('inconclusive');
  });

  it('tools: a returned tool call proves support; a chatty 200 proves nothing', () => {
    expect(classifyProbeSuccess('tools', response('', [{ id: '1', name: 'ping', arguments: '{}' }]))).toBe('supported');
    expect(classifyProbeSuccess('tools', response('I cannot call tools.'))).toBe('inconclusive');
  });
});

describe('classifyProbeError', () => {
  const providerErr = (status: number, code = 'provider_unavailable' as const): RouterError =>
    new RouterError(code, `provider error (HTTP ${status})`, { detail: { providerStatus: status } });

  it('definitive request rejection → unsupported', () => {
    expect(classifyProbeError(providerErr(400)).outcome).toBe('unsupported');
    expect(classifyProbeError(providerErr(415)).outcome).toBe('unsupported');
    expect(classifyProbeError(providerErr(422)).outcome).toBe('unsupported');
  });

  it('transient / unrelated failures → inconclusive, never a capability verdict', () => {
    expect(classifyProbeError(new RouterError('auth_error', 'bad key')).outcome).toBe('inconclusive');
    expect(classifyProbeError(new RouterError('rate_limited', 'slow down')).outcome).toBe('inconclusive');
    expect(classifyProbeError(providerErr(404)).outcome).toBe('inconclusive'); // wrong URL ≠ no vision
    expect(classifyProbeError(providerErr(500)).outcome).toBe('inconclusive');
    expect(classifyProbeError(new RouterError('provider_unavailable', 'timeout')).outcome).toBe('inconclusive');
    expect(classifyProbeError(new Error('boom')).outcome).toBe('inconclusive');
  });

  it('a 400 that mapped to context/content-filter codes is not a capability rejection', () => {
    const ctx = new RouterError('context_exceeded', 'too long', { detail: { providerStatus: 400 } });
    expect(classifyProbeError(ctx).outcome).toBe('inconclusive');
  });
});

describe('probeModelCapabilities + overridesFromProbes', () => {
  const fakeAdapter = (behavior: Record<string, () => AIResponse>): GatewayAdapter => ({
    kind: 'digitalocean',
    execute: (env) => {
      const cap = env.responseFormat ? 'json_schema' : env.tools ? 'tools' : 'vision';
      return Promise.resolve(behavior[cap]!());
    },
    executeStream: async function* (): AsyncIterable<never> {
      throw await Promise.reject(new Error('not used'));
    },
  });

  it('collects one verdict per capability and merges only conclusive ones into overrides', async () => {
    const adapter = fakeAdapter({
      vision: () => response('OK'),
      json_schema: () => response('{"ok":true}'),
      tools: () => {
        throw new RouterError('provider_unavailable', 'provider error (HTTP 400)', {
          detail: { providerStatus: 400 },
        });
      },
    });
    const results = await probeModelCapabilities(adapter, {
      providerId: 'p',
      model: 'digitalocean/kimi-k3',
      baseUrl: 'https://example.invalid/v1',
    });
    expect(results.map((r) => [r.capability, r.outcome])).toEqual([
      ['vision', 'supported'],
      ['json_schema', 'supported'],
      ['tools', 'unsupported'],
    ]);
    // existing operator override (caching) survives; probed keys are set from verdicts
    expect(overridesFromProbes({ caching: true, tools: true }, results)).toEqual({
      caching: true,
      vision: true,
      json_schema: true,
      tools: false,
    });
  });

  it('a probe never switches on a capability the KIND ceiling caps (Q-097 review)', () => {
    // llama-server answers the json_schema probe with parseable JSON because its grammar
    // constraint forces it to — that is the failure the ceiling exists to prevent
    const results = [
      { capability: 'json_schema', outcome: 'supported', detail: 'x', latencyMs: 1 },
      { capability: 'tools', outcome: 'supported', detail: 'x', latencyMs: 1 },
      { capability: 'vision', outcome: 'supported', detail: 'x', latencyMs: 1 },
    ] as const;
    expect(overridesFromProbes({}, [...results], 'local_ocr')).toEqual({ vision: true });
    // an 'unsupported' verdict may still write false; an existing by-hand override survives
    expect(
      overridesFromProbes({ json_schema: true }, [{ capability: 'tools', outcome: 'unsupported', detail: 'x', latencyMs: 1 }], 'local_ocr'),
    ).toEqual({ json_schema: true, tools: false });
    // other kinds are unaffected
    expect(overridesFromProbes({}, [...results], 'digitalocean')).toEqual({ json_schema: true, tools: true, vision: true });
    expect(overridesFromProbes({}, [...results])).toEqual({ json_schema: true, tools: true, vision: true });
    expect(ceilingCappedCapabilities('local_ocr').sort()).toEqual(['json_schema', 'tools']);
    expect(ceilingCappedCapabilities('local')).toEqual([]);
  });

  it('inconclusive probes leave existing overrides exactly as they were', async () => {
    const adapter = fakeAdapter({
      vision: () => {
        throw new RouterError('auth_error', 'bad key');
      },
      json_schema: () => response('not json at all'),
      tools: () => response('no tool call'),
    });
    const results = await probeModelCapabilities(adapter, {
      providerId: 'p',
      model: 'digitalocean/kimi-k3',
      baseUrl: 'https://example.invalid/v1',
    });
    expect(results.every((r) => r.outcome === 'inconclusive')).toBe(true);
    const existing = { vision: true, json_schema: false };
    expect(overridesFromProbes(existing, results)).toEqual(existing);
  });
});
