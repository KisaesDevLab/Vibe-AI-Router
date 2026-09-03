/**
 * SDK ↔ router contract drift guards (Vibe 1040 follow-ups, item A/B).
 *
 * The SDK's error-code union and the router's ERROR_CODES drifted once without anyone noticing:
 * an app vendoring an older dist had a narrower union, and `no_vision_provider` /
 * `invalid_response` fell through to its default branch. These assertions make the next drift a
 * red test instead of a production surprise, and keep the frozen contract doc honest too.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, type ErrorCode } from '../src/gateway/errors.js';
import { INVALID_RESPONSE_REASONS as ROUTER_REASONS } from '../src/gateway/verify.js';
import {
  INVALID_RESPONSE_REASONS as SDK_REASONS,
  VIBE_AI_ERROR_CODES,
  VibeAiError,
  isInvalidResponse,
  type VibeAiErrorCode,
} from '../packages/sdk/src/index.js';

// compile-time: every router code is assignable to the SDK union (fails typecheck on drift)
const _routerCodeIsSdkCode: VibeAiErrorCode = null as unknown as ErrorCode;
void _routerCodeIsSdkCode;

describe('SDK error taxonomy mirrors the router', () => {
  it('VIBE_AI_ERROR_CODES is a superset of the router ERROR_CODES', () => {
    const sdk = new Set<string>(VIBE_AI_ERROR_CODES);
    const missing = ERROR_CODES.filter((c) => !sdk.has(c));
    expect(missing).toEqual([]);
  });

  it('the only SDK-side extra is output_truncated (synthesized by completeJson)', () => {
    const router = new Set<string>(ERROR_CODES);
    const extras = VIBE_AI_ERROR_CODES.filter((c) => !router.has(c));
    expect(extras).toEqual(['output_truncated']);
  });

  it('INVALID_RESPONSE_REASONS is identical on both sides', () => {
    expect([...SDK_REASONS]).toEqual([...ROUTER_REASONS]);
  });

  it('isInvalidResponse narrows on a router-shaped error and rejects everything else', () => {
    const err = new VibeAiError('invalid_response', 502, 'x', undefined, { reason: 'json_truncated', path: '$' });
    expect(isInvalidResponse(err)).toBe(true);
    if (isInvalidResponse(err)) expect(err.detail.reason).toBe('json_truncated');
    expect(isInvalidResponse(new VibeAiError('invalid_response', 502, 'x'))).toBe(false); // no detail
    expect(isInvalidResponse(new VibeAiError('invalid_response', 502, 'x', undefined, { reason: 'made_up' }))).toBe(
      false,
    );
    expect(isInvalidResponse(new VibeAiError('rate_limited', 429, 'x'))).toBe(false);
    expect(isInvalidResponse(new Error('x'))).toBe(false);
  });
});

describe('docs/integration.md (frozen contract) documents every router error code', () => {
  it('the error table has a backticked row for each ERROR_CODES entry', async () => {
    const doc = await readFile(new URL('../docs/integration.md', import.meta.url), 'utf8');
    const table = doc.slice(doc.indexOf('## Errors'), doc.indexOf('## Versioning'));
    expect(table.length).toBeGreaterThan(0);
    const undocumented = ERROR_CODES.filter((c) => !table.includes(`\`${c}\``));
    expect(undocumented).toEqual([]);
    // and the SDK-only code too
    expect(table).toContain('`output_truncated`');
  });
});
