/**
 * Envelope encryption (6.1): per-appliance master key wraps a random per-credential DEK;
 * the DEK encrypts the credential. AES-256-GCM throughout. key_version on every row selects
 * the master key from the keyring, which is what makes master rotation (6.3) cheap.
 *
 * The ciphertext blob is a base64 JSON envelope — no plaintext column exists anywhere.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Keyring {
  /** version → 32-byte key */
  keys: Map<number, Buffer>;
  currentVersion: number;
}

export function keyringFromEnv(env: {
  MASTER_KEY?: string | undefined;
  MASTER_KEY_VERSION?: number | undefined;
  MASTER_KEY_PREVIOUS?: string | undefined;
  MASTER_KEY_PREVIOUS_VERSION?: number | undefined;
}): Keyring | undefined {
  if (!env.MASTER_KEY) return undefined;
  const current = Buffer.from(env.MASTER_KEY, 'base64');
  if (current.length !== 32) {
    throw new Error('MASTER_KEY must be 32 bytes base64 (openssl rand -base64 32)');
  }
  const currentVersion = env.MASTER_KEY_VERSION ?? 1;
  const keys = new Map<number, Buffer>([[currentVersion, current]]);
  if (env.MASTER_KEY_PREVIOUS) {
    const prev = Buffer.from(env.MASTER_KEY_PREVIOUS, 'base64');
    if (prev.length !== 32) throw new Error('MASTER_KEY_PREVIOUS must be 32 bytes base64');
    keys.set(env.MASTER_KEY_PREVIOUS_VERSION ?? currentVersion - 1, prev);
  }
  return { keys, currentVersion };
}

interface GcmBox {
  iv: string; // base64
  tag: string; // base64
  data: string; // base64
}

interface EnvelopeV1 {
  alg: 'A256GCM';
  /** DEK wrapped by the master key (version = row key_version) */
  dek: GcmBox;
  /** credential encrypted by the DEK */
  payload: GcmBox;
}

function seal(key: Buffer, plaintext: Buffer): GcmBox {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function open(key: Buffer, box: GcmBox): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
}

export function encryptCredential(
  plaintext: string,
  keyring: Keyring,
): { ciphertext: string; keyVersion: number } {
  const master = keyring.keys.get(keyring.currentVersion);
  if (!master) throw new Error('keyring missing current master key');
  const dek = randomBytes(32);
  const envelope: EnvelopeV1 = {
    alg: 'A256GCM',
    dek: seal(master, dek),
    payload: seal(dek, Buffer.from(plaintext, 'utf8')),
  };
  return {
    ciphertext: Buffer.from(JSON.stringify(envelope)).toString('base64'),
    keyVersion: keyring.currentVersion,
  };
}

export function decryptCredential(ciphertext: string, keyVersion: number, keyring: Keyring): string {
  const master = keyring.keys.get(keyVersion);
  if (!master) {
    // deliberately generic — never echo key material or ciphertext into errors (6.8)
    throw new Error(`no master key for key_version ${keyVersion}`);
  }
  let envelope: EnvelopeV1;
  try {
    envelope = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf8')) as EnvelopeV1;
  } catch {
    throw new Error('credential envelope is corrupt');
  }
  if (envelope.alg !== 'A256GCM') throw new Error(`unsupported envelope alg`);
  const dek = open(master, envelope.dek);
  return open(dek, envelope.payload).toString('utf8');
}

/** Re-wrap with the current master key (master rotation, 6.3). Payload DEK is reused. */
export function rewrapCredential(
  ciphertext: string,
  keyVersion: number,
  keyring: Keyring,
): { ciphertext: string; keyVersion: number } {
  const master = keyring.keys.get(keyVersion);
  const target = keyring.keys.get(keyring.currentVersion);
  if (!master || !target) throw new Error('keyring missing source or target master key');
  const envelope = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf8')) as EnvelopeV1;
  const dek = open(master, envelope.dek);
  const rewrapped: EnvelopeV1 = { ...envelope, dek: seal(target, dek) };
  return {
    ciphertext: Buffer.from(JSON.stringify(rewrapped)).toString('base64'),
    keyVersion: keyring.currentVersion,
  };
}

export function last4(secret: string): string {
  return secret.length <= 4 ? '****' : secret.slice(-4);
}
