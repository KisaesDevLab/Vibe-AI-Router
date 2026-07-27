/**
 * Credential lifecycle (6.2/6.4/6.5/6.7):
 *   add (staged unless first) → test → promote → old enters timed grace → auto-revoke.
 * Status semantics: `active` = serving; `grace` with grace_until=NULL = staged (new, not yet
 * promoted); `grace` with grace_until set = demoted, expiring; `revoked` = dead.
 * There is NO read-back path: nothing here ever returns plaintext except the internal
 * getActiveApiKey used by the route stage, which hands it straight to an adapter.
 */
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { providerCredentials, providers } from '../../db/schema.js';
import { RouterError } from '../gateway/errors.js';
import { writeAudit } from '../protect/audit.js';
import type { ProviderAdapter, ConnectionTestResult } from '../adapters/contract.js';
import { decryptCredential, encryptCredential, last4, type Keyring } from './crypto.js';

type CredentialRow = typeof providerCredentials.$inferSelect;

export interface CredentialMeta {
  id: string;
  providerId: string;
  last4: string;
  status: CredentialRow['status'];
  keyVersion: number;
  graceUntil: Date | null;
  createdAt: Date;
}

function toMeta(row: CredentialRow): CredentialMeta {
  return {
    id: row.id,
    providerId: row.providerId,
    last4: row.last4,
    status: row.status,
    keyVersion: row.keyVersion,
    graceUntil: row.graceUntil,
    createdAt: row.createdAt,
  };
}

export class CredentialVault {
  constructor(
    private readonly db: Db,
    private readonly keyring: Keyring,
    private readonly log: Logger,
    private readonly graceHours: number,
  ) {}

  /** Write-only add (6.2). First credential for a provider activates immediately. */
  async add(providerId: string, plaintext: string, createdBy?: string): Promise<CredentialMeta> {
    if (plaintext.length < 8) throw new RouterError('invalid_request', 'credential too short');
    const provider = await this.db.query.providers.findFirst({ where: eq(providers.id, providerId) });
    if (!provider || provider.deletedAt) throw new RouterError('invalid_request', 'provider not found');

    const activeExisting = await this.db.query.providerCredentials.findFirst({
      where: and(eq(providerCredentials.providerId, providerId), eq(providerCredentials.status, 'active')),
    });
    const { ciphertext, keyVersion } = encryptCredential(plaintext, this.keyring);
    const [row] = await this.db
      .insert(providerCredentials)
      .values({
        providerId,
        ciphertext,
        keyVersion,
        last4: last4(plaintext),
        status: activeExisting ? 'grace' : 'active', // staged unless first
        createdBy: createdBy ?? null,
        rotatedFrom: activeExisting?.id ?? null,
      })
      .returning();
    if (!row) throw new Error('credential insert failed');
    await writeAudit(this.db, {
      firmId: provider.firmId,
      event: 'config_change',
      provider: provider.label,
      detail: {
        entity: 'provider_credential',
        entityId: row.id,
        action: 'create',
        after: { last4: row.last4, status: row.status, key_version: row.keyVersion },
      },
    });
    return toMeta(row);
  }

  /** Staged → active; the previously active credential enters timed grace (6.4). */
  async promote(credentialId: string): Promise<CredentialMeta> {
    const cred = await this.db.query.providerCredentials.findFirst({
      where: eq(providerCredentials.id, credentialId),
    });
    if (!cred) throw new RouterError('invalid_request', 'credential not found');
    if (cred.status === 'revoked') throw new RouterError('invalid_request', 'credential is revoked');
    if (cred.status === 'active') return toMeta(cred);

    const provider = await this.db.query.providers.findFirst({ where: eq(providers.id, cred.providerId) });
    if (!provider) throw new RouterError('invalid_request', 'provider not found');

    const graceUntil = new Date(Date.now() + this.graceHours * 3600_000);
    const currentActive = await this.db.query.providerCredentials.findFirst({
      where: and(eq(providerCredentials.providerId, cred.providerId), eq(providerCredentials.status, 'active')),
    });
    if (currentActive) {
      await this.db
        .update(providerCredentials)
        .set({ status: 'grace', graceUntil })
        .where(eq(providerCredentials.id, currentActive.id));
    }
    const [updated] = await this.db
      .update(providerCredentials)
      .set({ status: 'active', graceUntil: null })
      .where(eq(providerCredentials.id, credentialId))
      .returning();
    await writeAudit(this.db, {
      firmId: provider.firmId,
      event: 'config_change',
      provider: provider.label,
      detail: {
        entity: 'provider_credential',
        entityId: credentialId,
        action: 'promote',
        before: currentActive ? { demoted: currentActive.id, grace_until: graceUntil.toISOString() } : {},
        after: { status: 'active' },
      },
    });
    return toMeta(updated!);
  }

  async revoke(credentialId: string): Promise<void> {
    const cred = await this.db.query.providerCredentials.findFirst({
      where: eq(providerCredentials.id, credentialId),
    });
    if (!cred) throw new RouterError('invalid_request', 'credential not found');
    const provider = await this.db.query.providers.findFirst({ where: eq(providers.id, cred.providerId) });
    await this.db
      .update(providerCredentials)
      .set({ status: 'revoked' })
      .where(eq(providerCredentials.id, credentialId));
    if (provider) {
      await writeAudit(this.db, {
        firmId: provider.firmId,
        event: 'config_change',
        provider: provider.label,
        detail: { entity: 'provider_credential', entityId: credentialId, action: 'revoke' },
      });
    }
  }

  /** Auto-revoke expired grace credentials (6.4) — scheduled alongside catalog jobs. */
  async autoRevokeExpired(): Promise<number> {
    const expired = await this.db
      .update(providerCredentials)
      .set({ status: 'revoked' })
      .where(and(eq(providerCredentials.status, 'grace'), lt(providerCredentials.graceUntil, new Date())))
      .returning();
    for (const cred of expired) {
      const provider = await this.db.query.providers.findFirst({ where: eq(providers.id, cred.providerId) });
      if (provider) {
        await writeAudit(this.db, {
          firmId: provider.firmId,
          event: 'config_change',
          provider: provider.label,
          detail: { entity: 'provider_credential', entityId: cred.id, action: 'revoke', after: { reason: 'grace_expired' } },
        });
      }
    }
    if (expired.length > 0) this.log.info({ count: expired.length }, 'auto-revoked expired grace credentials');
    return expired.length;
  }

  /** Metadata listing for the admin surface — never ciphertext, never plaintext (6.2/6.8). */
  async list(providerId: string): Promise<CredentialMeta[]> {
    const rows = await this.db.query.providerCredentials.findMany({
      where: eq(providerCredentials.providerId, providerId),
      orderBy: providerCredentials.createdAt,
    });
    return rows.map(toMeta);
  }

  /** Internal-only: decrypted key for adapter execution. Never logged, never serialized. */
  async getActiveApiKey(providerId: string): Promise<string | undefined> {
    const cred = await this.db.query.providerCredentials.findFirst({
      where: and(eq(providerCredentials.providerId, providerId), eq(providerCredentials.status, 'active')),
    });
    if (!cred) return undefined;
    return decryptCredential(cred.ciphertext, cred.keyVersion, this.keyring);
  }

  /**
   * Live connection test (6.5): decrypts the target credential (specific, else active, else
   * staged), runs the adapter's minimal call, stores result on the provider record.
   */
  async test(
    providerId: string,
    adapter: ProviderAdapter,
    opts?: { credentialId?: string; model?: string; signal?: AbortSignal },
  ): Promise<ConnectionTestResult> {
    const provider = await this.db.query.providers.findFirst({ where: eq(providers.id, providerId) });
    if (!provider || provider.deletedAt) throw new RouterError('invalid_request', 'provider not found');

    let apiKey: string | undefined;
    if (provider.authType === 'api_key') {
      const cred = opts?.credentialId
        ? await this.db.query.providerCredentials.findFirst({
            where: eq(providerCredentials.id, opts.credentialId),
          })
        : ((await this.db.query.providerCredentials.findFirst({
            where: and(
              eq(providerCredentials.providerId, providerId),
              eq(providerCredentials.status, 'active'),
            ),
          })) ??
          (await this.db.query.providerCredentials.findFirst({
            where: and(
              eq(providerCredentials.providerId, providerId),
              eq(providerCredentials.status, 'grace'),
              isNull(providerCredentials.graceUntil),
            ),
          })));
      if (!cred) throw new RouterError('invalid_request', 'no credential to test');
      apiKey = decryptCredential(cred.ciphertext, cred.keyVersion, this.keyring);
    }

    const result = await adapter.testConnection(
      {
        providerId,
        model: opts?.model ?? '',
        baseUrl: provider.baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(provider.modelMapping && typeof provider.modelMapping === 'object'
          ? { modelMapping: provider.modelMapping as Record<string, string> }
          : {}),
      },
      opts?.signal ?? AbortSignal.timeout(20_000),
    );

    await this.db
      .update(providers)
      .set({
        status: result.ok ? 'healthy' : 'down',
        lastHealthAt: new Date(),
        health: {
          lastTest: {
            ok: result.ok,
            latencyMs: result.latencyMs,
            ...(result.errorCode ? { errorCode: result.errorCode } : {}),
            ...(result.probedCapabilities ? { probed: result.probedCapabilities } : {}),
          },
        },
      })
      .where(eq(providers.id, providerId));

    await writeAudit(this.db, {
      firmId: provider.firmId,
      event: 'credential_test',
      provider: provider.label,
      detail: {
        ok: result.ok,
        latencyMs: result.latencyMs,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      },
    });
    return result;
  }

  /** Startup decryptability check (6.7): every active/grace credential must decrypt. */
  async startupCheck(): Promise<void> {
    const rows = await this.db.query.providerCredentials.findMany({
      where: (c, { inArray }) => inArray(c.status, ['active', 'grace']),
    });
    const failures: string[] = [];
    for (const row of rows) {
      try {
        decryptCredential(row.ciphertext, row.keyVersion, this.keyring);
      } catch (err) {
        failures.push(`${row.id} (key_version ${row.keyVersion}): ${(err as Error).message}`);
      }
    }
    if (failures.length > 0) {
      // fail LOUDLY — a wrong master key must never be discovered mid-request
      throw new Error(
        `credential vault startup check failed — ${failures.length} credential(s) cannot decrypt:\n` +
          failures.join('\n'),
      );
    }
    this.log.info({ checked: rows.length }, 'credential vault startup check passed');
  }
}
