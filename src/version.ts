/**
 * Single source of truth for the served version: read from package.json at startup so it can
 * never drift from the real release (it did — pinned at 0.0.3 through 0.0.6; Q-078). Resolved
 * from the package root, which works under both tsx (src/) and compiled (dist/src/) layouts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/version.ts → ../package.json ; dist/src/version.js → ../../package.json
  for (const candidate of [join(here, '../package.json'), join(here, '../../package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'vibe-ai-router' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      /* try the next candidate */
    }
  }
  return '0.0.0';
}

export const VERSION = readVersion();
