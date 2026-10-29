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
