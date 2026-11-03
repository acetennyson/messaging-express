import type { CryptoProvider } from '../crypto/provider';
import { fromBase64Url, toBase64Url } from '../format/base64url';
import { FormatError } from '../format/errors';

const QR_PREFIX = 'mxe2ee1:link:';

/** What the new device shows as a QR code. */
export const linkQrPayload = (publicKey: Uint8Array): string => QR_PREFIX + toBase64Url(publicKey);

/** The same key as a copyable code in groups of 4 separated by spaces (for manual entry). Case matters: it is base64url. */
export const linkCodeFor = (publicKey: Uint8Array): string => (toBase64Url(publicKey).match(/.{1,4}/g) ?? []).join(' ');

/** Accepts the QR payload or the spaced code (any whitespace ignored) and returns the 32-byte public key. */
export function parseLinkInput(input: string): Uint8Array {
  if (typeof input !== 'string') throw new FormatError('BAD_INPUT', 'link input must be a string');
  let s = input.trim();
  if (s.startsWith(QR_PREFIX)) s = s.slice(QR_PREFIX.length);
  s = s.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(s)) throw new FormatError('BAD_INPUT', 'not a valid link code');
  const b = fromBase64Url(s);
  if (b.length !== 32) throw new FormatError('BAD_INPUT', 'a link code holds a 32-byte public key');
  return b;
}

/**
 * Eight digits both devices derive from the NEW device's public key, shown as "1234 5678". The person compares them before confirming.
 * It catches a mistyped or swapped code. It is a human check, not a secret: against an attacker who can generate many keys and pick one
 * whose code matches, 8 digits is weak, so approve only a device you are holding.
 */
export function confirmationCodeFor(publicKey: Uint8Array, provider: CryptoProvider): string {
  const d = provider.hkdf(publicKey, new TextEncoder().encode('mx-e2ee-v1|link-confirm'), 4);
  const n = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
  const s = String(n % 100_000_000).padStart(8, '0');
  return `${s.slice(0, 4)} ${s.slice(4)}`;
}
