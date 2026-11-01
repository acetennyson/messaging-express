import { nobleProvider } from '../crypto/noble';
import { fromBase64Url, toBase64Url } from './base64url';
import { FormatError } from './errors';
import { KEY_LENGTH, NONCE_LENGTH, PAD_BLOCK, TAG_LENGTH, VERSION, concat, requireBytes, utf8, zeroize } from './context';
import { pad, unpad } from './padding';
import type { WireOptions } from './wrap';

/** Argon2id parameters, stored next to the blob (the server keeps them as the `kdf` JSON and validates the same ranges). m is in KiB. */
export interface BackupKdf { v: 1; alg: 'argon2id'; m: number; t: number; p: number; salt: string }
export interface BackupPayload { deviceId: string; privateKey: Uint8Array }

/** OWASP-recommended Argon2id minimum (19 MiB, 2 passes, 1 lane). Raise for stronger protection; the server accepts up to 4 GiB / 32 passes / 16 lanes. */
export const DEFAULT_BACKUP_PARAMS = { m: 19456, t: 2, p: 1 } as const;

const dec = new TextDecoder('utf-8', { fatal: true });

export function validateKdf(kdf: unknown): BackupKdf {
  const k = kdf as Partial<BackupKdf> | null;
  const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  if (!k || k.v !== 1 || k.alg !== 'argon2id' || !int(k.m, 1024, 4_194_304) || !int(k.t, 1, 32) || !int(k.p, 1, 16) || typeof k.salt !== 'string') throw new FormatError('BAD_INPUT', 'invalid backup kdf parameters');
  const salt = fromBase64Url(k.salt);
  if (salt.length < 16 || salt.length > 64) throw new FormatError('BAD_INPUT', 'backup salt must be 16 to 64 bytes');
  return k as BackupKdf;
}

/** The KDF header is the AAD: changing m, t, p or the salt makes the blob fail to authenticate, not merely derive a wrong key. */
export function backupAad(kdf: BackupKdf): Uint8Array {
  return utf8(`mx-e2ee-v1|backup|${kdf.v}|${kdf.alg}|${kdf.m}|${kdf.t}|${kdf.p}|${kdf.salt}`);
}

/** NFKC-normalise so the same passphrase typed on different keyboards or platforms derives the same key. */
export function passphraseBytes(passphrase: string): Uint8Array {
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new FormatError('BAD_INPUT', 'passphrase must be a non-empty string');
  return utf8(passphrase.normalize('NFKC'));
}

/** blob = 0x01 | nonce(24) | XChaCha20-Poly1305(pad64(JSON {deviceId, privateKey})) under Argon2id(passphrase, salt). */
export async function createBackup(payload: BackupPayload, passphrase: string, params: { m: number; t: number; p: number } = DEFAULT_BACKUP_PARAMS, opts: WireOptions & { salt?: Uint8Array } = {}): Promise<{ blob: string; kdf: BackupKdf }> {
  const c = opts.provider ?? nobleProvider;
  requireBytes('privateKey', payload.privateKey, 32);
  const salt = opts.salt ?? c.randomBytes(16);
  const kdf = validateKdf({ v: 1, alg: 'argon2id', m: params.m, t: params.t, p: params.p, salt: toBase64Url(salt) });
  const nonce = opts.nonce ?? c.randomBytes(NONCE_LENGTH);
  const key = await c.argon2id(passphraseBytes(passphrase), salt, { ...params, dkLength: KEY_LENGTH });
  try {
    const plain = pad(utf8(JSON.stringify({ deviceId: payload.deviceId, privateKey: toBase64Url(payload.privateKey) })));
    return { blob: toBase64Url(concat(new Uint8Array([VERSION]), nonce, c.aeadEncrypt(key, nonce, plain, backupAad(kdf)))), kdf };
  } finally {
    zeroize(key);
  }
}

/** Throws DecryptError for a wrong passphrase or a modified blob or header (indistinguishable on purpose). */
export async function restoreBackup(backup: { blob: string; kdf: unknown }, passphrase: string, opts: WireOptions = {}): Promise<BackupPayload> {
  const c = opts.provider ?? nobleProvider;
  const kdf = validateKdf(backup.kdf);
  const bytes = fromBase64Url(backup.blob);
  if (bytes.length < 1 + NONCE_LENGTH + PAD_BLOCK + TAG_LENGTH || (bytes.length - 1 - NONCE_LENGTH - TAG_LENGTH) % PAD_BLOCK !== 0) throw new FormatError('BAD_LENGTH', 'not a valid backup blob length');
  if (bytes[0] !== VERSION) throw new FormatError('UNKNOWN_VERSION', `unknown backup version ${bytes[0]}`);
  const key = await c.argon2id(passphraseBytes(passphrase), fromBase64Url(kdf.salt), { m: kdf.m, t: kdf.t, p: kdf.p, dkLength: KEY_LENGTH });
  try {
    const plain = unpad(c.aeadDecrypt(key, bytes.subarray(1, 1 + NONCE_LENGTH), bytes.subarray(1 + NONCE_LENGTH), backupAad(kdf)));
    let parsed: any;
    try { parsed = JSON.parse(dec.decode(plain)); } catch { throw new FormatError('BAD_PAYLOAD', 'backup payload is not valid UTF-8 JSON'); }
    if (!parsed || typeof parsed.deviceId !== 'string' || typeof parsed.privateKey !== 'string') throw new FormatError('BAD_PAYLOAD', 'unsupported backup payload shape');
    const privateKey = fromBase64Url(parsed.privateKey);
    requireBytes('privateKey', privateKey, 32);
    return { deviceId: parsed.deviceId, privateKey };
  } finally {
    zeroize(key);
  }
}
