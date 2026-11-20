import { z } from 'zod';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: string): boolean => UUID.test(v);

/** An X25519 public key: exactly 32 bytes, base64url without padding (43 characters). */
export const publicKeySchema = z
  .string()
  .length(43, 'publicKey must be 32 bytes, base64url encoded')
  .regex(BASE64URL, 'publicKey must be base64url')
  .refine((s) => Buffer.from(s, 'base64url').length === 32, 'publicKey must be 32 bytes, base64url encoded');

export const registerDeviceSchema = z.object({
  publicKey: publicKeySchema,
  deviceName: z.string().trim().min(1).max(64).optional(),
});

const MAX_USER_IDS = 50;

/** `?userIds=a,b,c`: 1..50 distinct UUIDs. */
export const listDevicesQuerySchema = z.object({
  userIds: z
    .string()
    .transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))])
    .pipe(
      z
        .array(z.string().regex(UUID, 'userIds must be UUIDs'))
        .min(1, 'userIds must contain at least one id')
        .max(MAX_USER_IDS, `userIds accepts at most ${MAX_USER_IDS} ids`)
    ),
});

/** POST /devices/pair: the primary approves the NEW device's public key (scanned from its QR / link code). */
export const pairDeviceSchema = z.object({ publicKey: publicKeySchema });

/** POST /devices/link: the new device claims the approval for its own public key. */
export const linkDeviceSchema = z.object({
  publicKey: publicKeySchema,
  deviceName: z.string().trim().min(1).max(64).optional(),
});

/**
 * A conversation key wrapped for one device. Opaque to the server: base64url, 41..512 bytes decoded
 * (the v1 layout is 1 version byte + 24 nonce + 32 key + 16 tag = 73 bytes; the range leaves room for later versions).
 */
export const wrappedKeySchema = z
  .string()
  .min(55)
  .max(683)
  .regex(BASE64URL, 'wrappedKey must be base64url');

export const keyEntrySchema = z.object({
  deviceId: z.string().regex(UUID, 'deviceId must be a UUID'),
  wrappedKey: wrappedKeySchema,
  wrappedByDeviceId: z.string().regex(UUID, 'wrappedByDeviceId must be a UUID'),
});

export const uploadKeysSchema = z.object({
  keyVersion: z.number().int().min(1),
  keys: z.array(keyEntrySchema).min(1).max(1000),
});

export const keyRequestSchema = z.object({ keyVersion: z.number().int().min(1).optional() });

export type KeyEntry = z.infer<typeof keyEntrySchema>;

// ---- Key backup (Stage 7.8) ----
/** Max decoded size of the passphrase-encrypted backup blob. */
export const MAX_BACKUP_BLOB_BYTES = 8192;
const b64urlBytes = (s: string) => (/^[A-Za-z0-9_-]+$/.test(s) ? Buffer.from(s, 'base64url').length : -1);

/** Argon2id parameters the client used, stored verbatim so any device can re-derive the key. Unknown fields are rejected. */
export const backupKdfSchema = z
  .object({
    v: z.literal(1),
    alg: z.literal('argon2id'),
    m: z.number().int().min(1024).max(4_194_304), // memory, KiB
    t: z.number().int().min(1).max(32),
    p: z.number().int().min(1).max(16),
    salt: z.string().max(128).refine((s) => b64urlBytes(s) >= 16 && b64urlBytes(s) <= 64, 'salt must be 16-64 bytes, base64url encoded'),
  })
  .strict();

export const putBackupSchema = z
  .object({
    blob: z
      .string()
      .max(Math.ceil((MAX_BACKUP_BLOB_BYTES * 4) / 3) + 4)
      .refine((s) => b64urlBytes(s) >= 1 && b64urlBytes(s) <= MAX_BACKUP_BLOB_BYTES, `blob must be base64url, at most ${MAX_BACKUP_BLOB_BYTES} bytes`),
    kdf: backupKdfSchema,
  })
  .strict();
