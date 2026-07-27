/**
 * Credential vault (Phase 6): envelope crypto, lifecycle add→test→promote→grace→auto-revoke,
 * master rotation rewrap, startup check, and the no-plaintext invariant (6.8).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, type DbHandle } from '../src/db/client.js';
import { providerCredentials, providers } from '../db/schema.js';
import {
  decryptCredential,
  encryptCredential,
  keyringFromEnv,
  last4,
  rewrapCredential,
  type Keyring,
} from '../src/vault/crypto.js';
import { CredentialVault } from '../src/vault/service.js';
import { HealthMonitor } from '../src/vault/health.js';
import { createLogger } from '../src/lib/logger.js';
import { resetDb } from './helpers.js';
import type { ProviderAdapter } from '../src/adapters/contract.js';

const url = process.env['VIBE_ROUTER_TEST_DATABASE_URL'];
const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');
const SECRET = 'sk-live-supersecret-abcd1234';

function ring(): Keyring {
  return keyringFromEnv({ MASTER_KEY: K1, MASTER_KEY_VERSION: 1 })!;
}

describe('envelope crypto (6.1)', () => {
  it('round-trips and never leaks plaintext into the ciphertext blob (6.8)', () => {
    const kr = ring();
    const { ciphertext, keyVersion } = encryptCredential(SECRET, kr);
    expect(keyVersion).toBe(1);
    expect(ciphertext).not.toContain(SECRET);
    expect(Buffer.from(ciphertext, 'base64').toString('utf8')).not.toContain(SECRET);
    expect(decryptCredential(ciphertext, keyVersion, kr)).toBe(SECRET);
  });

  it('two encryptions of the same secret differ (fresh DEK + IV)', () => {
    const kr = ring();
    expect(encryptCredential(SECRET, kr).ciphertext).not.toBe(encryptCredential(SECRET, kr).ciphertext);
  });

  it('rejects wrong key version, corrupt envelopes, and non-32B master keys', () => {
    const kr = ring();
    const { ciphertext } = encryptCredential(SECRET, kr);
    expect(() => decryptCredential(ciphertext, 9, kr)).toThrow(/no master key for key_version 9/);
    expect(() => decryptCredential('not-base64-json', 1, kr)).toThrow(/corrupt/);
    expect(() => keyringFromEnv({ MASTER_KEY: 'dG9vc2hvcnQ=' })).toThrow(/32 bytes/);
  });

  it('rewrap moves key_version without touching the payload (6.3)', () => {
    const kr = ring();
    const { ciphertext } = encryptCredential(SECRET, kr);
    const rotationRing: Keyring = {
      keys: new Map([
        [1, Buffer.from(K1, 'base64')],
        [2, Buffer.from(K2, 'base64')],
      ]),
      currentVersion: 2,
    };
    const rewrapped = rewrapCredential(ciphertext, 1, rotationRing);
    expect(rewrapped.keyVersion).toBe(2);
    expect(decryptCredential(rewrapped.ciphertext, 2, rotationRing)).toBe(SECRET);
    // old ciphertext still opens with old key — rotation window safety
    expect(decryptCredential(ciphertext, 1, rotationRing)).toBe(SECRET);
  });

  it('last4 masks short secrets entirely', () => {
    expect(last4('ab')).toBe('****');
    expect(last4(SECRET)).toBe('1234');
  });
});

describe.skipIf(!url)('credential lifecycle (6.2/6.4/6.7/6.8)', () => {
  let handle: DbHandle;
  let vault: CredentialVault;
  let providerId: string;
  const log = createLogger('silent', false);

  beforeAll(async () => {
    const dbUrl = url as string;
    await resetDb(dbUrl);
    handle = createDb(dbUrl, 2);
    vault = new CredentialVault(handle.db, ring(), log, 24);
    // seed provider is keyless local — create a cloud provider to exercise credentials
    const firm = await handle.db.query.firms.findFirst();
    const [p] = await handle.db
      .insert(providers)
      .values({
        firmId: firm!.id,
        kind: 'anthropic',
        label: 'Anthropic (test)',
        baseUrl: 'https://api.anthropic.com',
        authType: 'api_key',
      })
      .returning();
    providerId = p!.id;
    return async () => handle.close();
  });

  it('first add activates; second add stages; metadata never exposes material (6.2/6.8)', async () => {
    const first = await vault.add(providerId, SECRET);
    expect(first.status).toBe('active');
    expect(first.last4).toBe('1234');
    expect(JSON.stringify(first)).not.toContain(SECRET);

    const second = await vault.add(providerId, 'sk-live-newer-key-5678');
    expect(second.status).toBe('grace');
    expect(second.graceUntil).toBeNull(); // staged, not expiring

    const listing = await vault.list(providerId);
    expect(JSON.stringify(listing)).not.toContain(SECRET);
    expect(JSON.stringify(listing)).not.toContain('sk-live-newer-key-5678');
    expect(listing.every((c) => !('ciphertext' in c))).toBe(true);
  });

  it('promote flips staged→active and demotes old into timed grace (6.4)', async () => {
    const listing = await vault.list(providerId);
    const staged = listing.find((c) => c.status === 'grace' && c.graceUntil === null)!;
    const promoted = await vault.promote(staged.id);
    expect(promoted.status).toBe('active');

    const after = await vault.list(providerId);
    const demoted = after.find((c) => c.id !== staged.id)!;
    expect(demoted.status).toBe('grace');
    expect(demoted.graceUntil).not.toBeNull();

    // serving key is now the promoted one
    expect(await vault.getActiveApiKey(providerId)).toBe('sk-live-newer-key-5678');
  });

  it('auto-revoke reaps expired grace credentials (6.4)', async () => {
    // force the demoted credential's grace window into the past
    await handle.db
      .update(providerCredentials)
      .set({ graceUntil: new Date(Date.now() - 1000) })
      .where(eq(providerCredentials.status, 'grace'));
    const reaped = await vault.autoRevokeExpired();
    expect(reaped).toBe(1);
    const listing = await vault.list(providerId);
    expect(listing.filter((c) => c.status === 'revoked').length).toBe(1);
  });

  it('test action stores result + latency on the provider record (6.5)', async () => {
    const okAdapter: ProviderAdapter = {
      kind: 'anthropic',
      capabilities: () => ({
        streaming: true,
        tools: true,
        jsonSchema: true,
        vision: true,
        promptCaching: true,
        reasoning: true,
      }),
      translateRequest: () => ({ url: '', method: 'POST', headers: {}, body: {} }),
      translateResponse: () => ({ tag: 'unused' }) as never,
      translateStreamChunk: () => [],
      execute: () => Promise.reject(new Error('unused')),
      executeStream: async function* () {
        await Promise.resolve();
        yield* [];
      },
      testConnection: (ctx) => {
        // the decrypted key must reach the adapter — and only the adapter
        expect(ctx.apiKey).toBe('sk-live-newer-key-5678');
        return Promise.resolve({ ok: true, latencyMs: 42 });
      },
    };
    const result = await vault.test(providerId, okAdapter);
    expect(result.ok).toBe(true);

    const provider = await handle.db.query.providers.findFirst({ where: eq(providers.id, providerId) });
    expect(provider?.status).toBe('healthy');
    expect(provider?.lastHealthAt).not.toBeNull();
    expect((provider?.health as { lastTest: { latencyMs: number } }).lastTest.latencyMs).toBe(42);
    expect(JSON.stringify(provider?.health)).not.toContain('sk-live');
  });

  it('startup check passes on decryptable set, fails loudly on wrong keyring (6.7)', async () => {
    await expect(vault.startupCheck()).resolves.toBeUndefined();
    const wrongRing = keyringFromEnv({ MASTER_KEY: K2, MASTER_KEY_VERSION: 1 })!;
    const wrongVault = new CredentialVault(handle.db, wrongRing, log, 24);
    await expect(wrongVault.startupCheck()).rejects.toThrow(/cannot decrypt/);
  });

  it('audit trail for lifecycle events carries metadata only (6.8)', async () => {
    const rows = await handle.db.query.auditLog.findMany();
    const credEvents = rows.filter(
      (r) => r.event === 'config_change' || r.event === 'credential_test',
    );
    expect(credEvents.length).toBeGreaterThanOrEqual(4); // create×2, promote, revoke(auto), test
    const serialized = JSON.stringify(credEvents);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('sk-live-newer-key-5678');
  });
});

describe.skipIf(!url)('health monitor (6.6)', () => {
  it('transitions healthy→down on error-rate threshold and persists + audits', async () => {
    const dbUrl = url as string;
    const handle = createDb(dbUrl, 2);
    try {
      const firm = await handle.db.query.firms.findFirst();
      const provider = await handle.db.query.providers.findFirst();
      const monitor = new HealthMonitor(handle.db, createLogger('silent', false));

      for (let i = 0; i < 12; i++) monitor.record(provider!.id, firm!.id, provider!.label, true);
      expect(monitor.status(provider!.id)).toBe('healthy');

      for (let i = 0; i < 30; i++) monitor.record(provider!.id, firm!.id, provider!.label, false);
      expect(monitor.status(provider!.id)).toBe('down');
      expect(monitor.errorRate(provider!.id).rate).toBeGreaterThan(0.5);

      await monitor.flush(); // persists are chained per provider; flush awaits them
      const after = await handle.db.query.providers.findFirst({
        where: eq(providers.id, provider!.id),
      });
      expect(after?.status).toBe('down');
      const audits = await handle.db.query.auditLog.findMany();
      expect(audits.some((a) => a.event === 'provider_health_changed')).toBe(true);
    } finally {
      await handle.close();
    }
  });
});
