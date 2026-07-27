/**
 * Master key rotation (6.3). Re-wraps every credential's DEK under the new master key and
 * bumps key_version. The credential payloads themselves are untouched.
 *
 *   DATABASE_URL=…                      target database
 *   OLD_MASTER_KEY=… OLD_MASTER_KEY_VERSION=1
 *   NEW_MASTER_KEY=… NEW_MASTER_KEY_VERSION=2
 *   pnpm tsx scripts/rotate-master-key.ts
 *
 * Afterwards set MASTER_KEY=<new> MASTER_KEY_VERSION=<new version> in the router env and
 * restart. Full procedure: docs/runbook.md.
 */
import { eq } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import { providerCredentials } from '../db/schema.js';
import { rewrapCredential, type Keyring } from '../src/vault/crypto.js';

const out = (m: string): void => void process.stdout.write(m + '\n');

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  const oldKey = process.env['OLD_MASTER_KEY'];
  const newKey = process.env['NEW_MASTER_KEY'];
  if (!url || !oldKey || !newKey) {
    process.stderr.write('DATABASE_URL, OLD_MASTER_KEY and NEW_MASTER_KEY are required\n');
    process.exit(1);
  }
  const oldVersion = Number(process.env['OLD_MASTER_KEY_VERSION'] ?? 1);
  const newVersion = Number(process.env['NEW_MASTER_KEY_VERSION'] ?? oldVersion + 1);
  if (newVersion <= oldVersion) {
    process.stderr.write('NEW_MASTER_KEY_VERSION must be greater than OLD_MASTER_KEY_VERSION\n');
    process.exit(1);
  }
  const keyring: Keyring = {
    keys: new Map([
      [oldVersion, Buffer.from(oldKey, 'base64')],
      [newVersion, Buffer.from(newKey, 'base64')],
    ]),
    currentVersion: newVersion,
  };
  for (const [v, k] of keyring.keys) {
    if (k.length !== 32) {
      process.stderr.write(`master key v${v} is not 32 bytes base64\n`);
      process.exit(1);
    }
  }

  const { db, sql, close } = createDb(url, 2);
  try {
    const rows = await db.query.providerCredentials.findMany();
    let rewrapped = 0;
    let skipped = 0;
    await sql.begin(async () => {
      for (const row of rows) {
        if (row.status === 'revoked') {
          skipped++;
          continue;
        }
        if (row.keyVersion === newVersion) {
          skipped++;
          continue;
        }
        const next = rewrapCredential(row.ciphertext, row.keyVersion, keyring);
        await db
          .update(providerCredentials)
          .set({ ciphertext: next.ciphertext, keyVersion: next.keyVersion })
          .where(eq(providerCredentials.id, row.id));
        rewrapped++;
      }
    });
    out(`rotated master key v${oldVersion} → v${newVersion}: ${rewrapped} re-wrapped, ${skipped} skipped`);
    out('NEXT: set MASTER_KEY=<new>, MASTER_KEY_VERSION=' + String(newVersion) + ' and restart the router.');
  } finally {
    await close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(String(e instanceof Error ? e.message : e) + '\n');
  process.exit(1);
});
