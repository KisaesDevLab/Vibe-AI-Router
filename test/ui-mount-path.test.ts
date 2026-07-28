/**
 * The admin UI ships one build that must work at a hostname root AND under a
 * path prefix, because the appliance serves it both ways. Assets handle that
 * via Vite's relative `base`; API calls handle it via resolveMountPath, which
 * is the piece with edge cases worth pinning.
 *
 * Regression guard for: the bundle asking for /admin-api/* at the host root
 * when it was served from /ai-router/, which on the appliance reaches a
 * different app and looks exactly like the router being down.
 */

import { describe, expect, it } from 'vitest';
import { resolveMountPath } from '../ui/src/api.js';

describe('resolveMountPath', () => {
  it('is empty at a hostname root', () => {
    expect(resolveMountPath('https://airouter.firm.com/')).toBe('');
  });

  it('returns the prefix under a path mount', () => {
    expect(resolveMountPath('https://vibe.firm.com/ai-router/')).toBe('/ai-router');
  });

  it('handles nested prefixes', () => {
    expect(resolveMountPath('https://vibe.firm.com/apps/ai-router/')).toBe('/apps/ai-router');
  });

  it('ignores query strings and fragments', () => {
    expect(resolveMountPath('https://vibe.firm.com/ai-router/?tab=models#x')).toBe('/ai-router');
  });

  it('drops a trailing file name — the document directory is what mounts', () => {
    expect(resolveMountPath('https://vibe.firm.com/ai-router/index.html')).toBe('/ai-router');
  });

  it('degrades to root (today\'s behaviour) when served without a trailing slash', () => {
    // Proxies redirect the bare form; if one does not, this is no worse than
    // the absolute-path build it replaces.
    expect(resolveMountPath('https://vibe.firm.com/ai-router')).toBe('');
  });

  it('works on plain HTTP and non-default ports (the emergency port)', () => {
    expect(resolveMountPath('http://192.168.1.10:5193/')).toBe('');
  });

  it('never throws on a malformed baseURI', () => {
    expect(resolveMountPath('not a url')).toBe('');
    expect(resolveMountPath('')).toBe('');
  });
});
