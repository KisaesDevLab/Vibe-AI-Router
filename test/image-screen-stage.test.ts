/**
 * stageImageScreen enforcement (8.6) — the decisions the pure screener does not make:
 * when to run at all, when to bar the cloud hop outright, and when to bar only fallbacks.
 * The reader is mocked so these are pure decision tests; test/image-screen.test.ts covers
 * the screening itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildImageReader = vi.hoisted(() => vi.fn());
vi.mock('../src/protect/image-reader.js', () => ({ buildImageReader }));

import {
  newPipelineCtx,
  routeForModel,
  stageImageScreen,
  type PipelineDeps,
} from '../src/gateway/pipeline.js';
import type { AIRequest } from '../src/gateway/envelope.js';
import type { EffectivePolicy } from '../src/policy/engine.js';
import type { AuditEntry } from '../src/protect/audit.js';
import { RouterError } from '../src/gateway/errors.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const signal = new AbortController().signal;

function model(kind: string, id: string) {
  return {
    id,
    canonicalId: `${kind}/m`,
    providerKind: kind,
    displayName: id,
    contextWindow: 32768,
    maxOutput: null,
    capabilities: { vision: true, json_schema: true },
    capabilityOverrides: {},
    status: 'active',
    deprecationDate: null,
    source: 'custom',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as EffectivePolicy['defaultModel'];
}

/** primaryKind = what the class's default model is; fallbackKinds = the chain after it */
function effective(primaryKind: string, fallbackKinds: string[] = []): EffectivePolicy {
  const primary = model(primaryKind, 'primary');
  const fallbacks = fallbackKinds.map((k, i) => model(k, `fb${i}`));
  return {
    taskClass: {
      key: 'timebill_file_naming',
      sensitivity: 'cloud_deidentified',
      requires: { vision: true },
      defaultMaxTokens: 300,
    } as unknown as EffectivePolicy['taskClass'],
    policy: {
      allowedModelIds: [primary.id],
      fallbackChain: fallbacks.map((f) => f.id),
      maxTokensOverride: null,
      temperatureMin: null,
      temperatureMax: null,
    } as unknown as EffectivePolicy['policy'],
    defaultModel: primary,
    modelsById: new Map([primary, ...fallbacks].map((m) => [m.id, m])),
    roleRules: new Map(),
    firmSettings: {},
  };
}

function envelope(withImage: boolean): AIRequest {
  return {
    taskClass: 'timebill_file_naming',
    stream: false,
    metadata: { app: 'vibe-time-billing' },
    messages: [
      {
        role: 'user',
        content: withImage
          ? [{ type: 'image', url: PNG }, { type: 'text', text: 'name this document' }]
          : [{ type: 'text', text: 'name this document' }],
      },
    ],
  };
}

function ctxFor(eff: EffectivePolicy, withImage = true) {
  const ctx = newPipelineCtx(envelope(withImage));
  ctx.auth = { firmId: 'firm-1', app: 'vibe-time-billing' } as never;
  ctx.effective = eff;
  return ctx;
}

let audits: AuditEntry[];
const deps = (): PipelineDeps =>
  ({ audit: (e: AuditEntry) => audits.push(e) }) as unknown as PipelineDeps;

const readsAs = (text: string) => ({ read: () => Promise.resolve(text), model: model('local_ocr', 'ocr') });

beforeEach(() => {
  audits = [];
  buildImageReader.mockReset();
});

describe('when the stage does nothing', () => {
  it('skips a text-only request without ever building a reader', async () => {
    await stageImageScreen(ctxFor(effective('digitalocean'), false), deps(), signal);
    expect(buildImageReader).not.toHaveBeenCalled();
  });

  it('skips an image request that can only ever be served locally', async () => {
    await stageImageScreen(ctxFor(effective('local_ocr')), deps(), signal);
    expect(buildImageReader).not.toHaveBeenCalled();
  });

  it('lets a clean page through to a cloud model', async () => {
    buildImageReader.mockResolvedValue(readsAs('Form 1040 tax year 2025'));
    const ctx = ctxFor(effective('digitalocean'));
    await stageImageScreen(ctx, deps(), signal);
    expect(ctx.cloudBlockedImages).toBeUndefined();
    expect(audits).toHaveLength(0);
  });
});

describe('barring cloud egress', () => {
  it('blocks the request when the primary is cloud and the page carries an SSN', async () => {
    buildImageReader.mockResolvedValue(readsAs('SSN 123-45-6789'));
    const ctx = ctxFor(effective('digitalocean'));
    await expect(stageImageScreen(ctx, deps(), signal)).rejects.toMatchObject({
      code: 'scrubber_blocked',
    });
    expect(audits[0]).toMatchObject({
      event: 'blocked_image_screen',
      detail: { verdict: 'identifier', matches: { ssn: 1 } },
    });
  });

  it('blocks when the appliance has no local reader at all', async () => {
    buildImageReader.mockResolvedValue(null);
    const ctx = ctxFor(effective('digitalocean'));
    await expect(stageImageScreen(ctx, deps(), signal)).rejects.toMatchObject({
      code: 'scrubber_blocked',
    });
    expect(audits[0]).toMatchObject({ event: 'blocked_image_screen', detail: { verdict: 'unreadable' } });
  });

  it('blocks when the reader throws — a failed screen is never an allow', async () => {
    buildImageReader.mockResolvedValue({
      read: () => Promise.reject(new Error('ocr down')),
      model: model('local_ocr', 'ocr'),
    });
    await expect(stageImageScreen(ctxFor(effective('digitalocean')), deps(), signal)).rejects.toMatchObject({
      code: 'scrubber_blocked',
    });
  });

  it('never leaks the recognized text into the thrown error', async () => {
    buildImageReader.mockResolvedValue(readsAs('SSN 123-45-6789 Jane Doe'));
    let caught: RouterError | undefined;
    try {
      await stageImageScreen(ctxFor(effective('digitalocean')), deps(), signal);
    } catch (e) {
      caught = e as RouterError;
    }
    expect(caught).toBeDefined();
    const serialized = JSON.stringify({ m: caught?.message, d: caught?.detail });
    expect(serialized).not.toContain('123-45-6789');
    expect(serialized).not.toContain('Jane Doe');
  });
});

describe('local primary with a cloud fallback', () => {
  it('defers the screen instead of paying a vision call the local path never needs', async () => {
    buildImageReader.mockResolvedValue(readsAs('SSN 123-45-6789'));
    const ctx = ctxFor(effective('local_ocr', ['digitalocean']));
    await stageImageScreen(ctx, deps(), signal);
    expect(buildImageReader).not.toHaveBeenCalled(); // the whole point: no inference up front
    expect(ctx.imageScreenPending).toBe(true);
    expect(ctx.cloudBlockedImages).toBeUndefined();
  });

  it('screens and bars only when a cloud hop is actually reached', async () => {
    buildImageReader.mockResolvedValue(readsAs('SSN 123-45-6789'));
    const eff = effective('local_ocr', ['digitalocean']);
    const ctx = ctxFor(eff);
    ctx.signal = signal;
    await stageImageScreen(ctx, deps(), signal);

    const cloudHop = eff.modelsById.get('fb0')!;
    await expect(routeForModel(cloudHop, ctx, deps())).rejects.toMatchObject({
      code: 'scrubber_blocked',
    });
    expect(buildImageReader).toHaveBeenCalledTimes(1);
    expect(ctx.cloudBlockedImages).toMatchObject({ verdict: 'identifier', counts: { ssn: 1 } });
    expect(audits[0]).toMatchObject({ event: 'blocked_image_screen', detail: { scope: 'fallback_only' } });
  });

  it('screens once across a chain of cloud hops, not once per hop', async () => {
    buildImageReader.mockResolvedValue(readsAs('SSN 123-45-6789'));
    const eff = effective('local_ocr', ['digitalocean', 'anthropic']);
    const ctx = ctxFor(eff);
    ctx.signal = signal;
    await stageImageScreen(ctx, deps(), signal);

    await routeForModel(eff.modelsById.get('fb0')!, ctx, deps()).catch(() => undefined);
    await routeForModel(eff.modelsById.get('fb1')!, ctx, deps()).catch(() => undefined);
    expect(buildImageReader).toHaveBeenCalledTimes(1);
    expect(audits.filter((a) => a.event === 'blocked_image_screen')).toHaveLength(1);
  });
});

describe('warn mode', () => {
  it('records the verdict without barring anything', async () => {
    buildImageReader.mockResolvedValue(readsAs('SSN 123-45-6789'));
    const eff = effective('digitalocean');
    eff.firmSettings = { scrubber_mode: 'warn' } as EffectivePolicy['firmSettings'];
    const ctx = ctxFor(eff);
    await stageImageScreen(ctx, deps(), signal);
    expect(ctx.cloudBlockedImages).toBeUndefined();
    expect(audits[0]).toMatchObject({ event: 'image_screen_warning', detail: { verdict: 'identifier' } });
  });
});
