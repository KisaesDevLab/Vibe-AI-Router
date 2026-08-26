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

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mounted, resolveMountPath } from '../ui/src/api.js';

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

describe('mounted', () => {
  // no `document` under vitest → MOUNT_PATH is '', the hostname-root case
  it('passes absolute API paths through unchanged at a hostname root', () => {
    expect(mounted('/admin-api/audit.csv')).toBe('/admin-api/audit.csv');
    expect(mounted('/admin-api/dashboard/costs.csv?from=2026-08-01')).toBe(
      '/admin-api/dashboard/costs.csv?from=2026-08-01',
    );
  });

  it('leaves already-relative URLs alone', () => {
    expect(mounted('admin-api/x')).toBe('admin-api/x');
  });
});

/**
 * File downloads are plain `<a href>`s, so they never pass through the api wrapper's fetch and
 * do not inherit its mount handling. A hard-coded `href="/admin-api/…"` therefore resolves
 * against the HOST ROOT under a path mount — the same failure this whole module exists to fix,
 * except it hits only the export buttons, so the console looks fine until someone clicks one.
 * Guard the class of bug, not the three instances known today.
 */
describe('UI download links', () => {
  it('route every absolute /admin-api href through mounted()', async () => {
    const root = join(import.meta.dirname, '..', 'ui', 'src');
    const offenders: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const src = await readFile(path, 'utf8');
        // href="/admin-api/…" or href={`/admin-api/…`} — both bypass mounted()
        for (const m of src.matchAll(/href=(?:"|\{`)(\/admin-api\/[^"`]*)/g)) {
          offenders.push(`${entry.name}: ${m[1]}`);
        }
      }
    };
    await walk(root);

    expect(offenders, `wrap these in mounted(): ${offenders.join(', ')}`).toEqual([]);
  });
});
