import type { CryptoProvider } from '../crypto/provider';
import { nobleProvider } from '../crypto/noble';
import { fromBase64Url } from '../format/base64url';
import { FormatError } from '../format/errors';

const utf8 = (s: string) => new TextEncoder().encode(s);
const INFO = utf8('mx-e2ee-v1|safety-fingerprint|1');
const GROUP_COUNT = 6; // per user: 6 groups of 5 digits = 30 digits, about 100 bits

/**
 * The fingerprint of one user: HKDF-SHA256 over (user id, NUL, the user's active device public keys sorted bytewise), 30 bytes, shown as
 * 6 groups of 5 digits (each group: 5 bytes as a number mod 100000). It changes whenever a device is added or removed.
 * Pure: the same input gives the same digits on every platform (see test/vectors and scripts/crosscheck.py).
 */
export function fingerprintOf(userId: string, publicKeys: Array<Uint8Array | string>, provider: CryptoProvider = nobleProvider): string[] {
  if (typeof userId !== 'string' || !userId || userId.includes('\0')) throw new FormatError('BAD_INPUT', 'userId must be a non-empty string without NUL');
  const keys = publicKeys.map((k) => (typeof k === 'string' ? fromBase64Url(k) : k));
  if (!keys.length) throw new FormatError('BAD_INPUT', 'a fingerprint needs at least one device key');
  for (const k of keys) if (k.length !== 32) throw new FormatError('BAD_LENGTH', 'device public keys are 32 bytes');
  const sorted = [...keys].sort(cmp);
  const unique = sorted.filter((k, i) => i === 0 || cmp(sorted[i - 1], k) !== 0);
  const u = utf8(userId);
  const ikm = new Uint8Array(u.length + 1 + unique.length * 32); // userId, NUL, keys: unambiguous because keys are fixed-length and the id has no NUL
  ikm.set(u, 0);
  unique.forEach((k, i) => ikm.set(k, u.length + 1 + i * 32));
  const d = provider.hkdf(ikm, INFO, GROUP_COUNT * 5);
  const groups: string[] = [];
  for (let g = 0; g < GROUP_COUNT; g++) {
    let n = 0;
    for (let i = 0; i < 5; i++) n = n * 256 + d[g * 5 + i];
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups;
}
function cmp(a: Uint8Array, b: Uint8Array): number { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

/**
 * The number two people compare: both fingerprints, ordered by user id so that both sides compute the same thing, 12 groups of 5 digits.
 * Read it aloud, or show it as a QR payload (`mxe2ee1:safety:<digits>`).
 */
export function safetyNumberOf(a: { userId: string; publicKeys: Array<Uint8Array | string> }, b: { userId: string; publicKeys: Array<Uint8Array | string> }, provider: CryptoProvider = nobleProvider): { groups: string[]; digits: string; text: string; qrPayload: string } {
  if (a.userId === b.userId) throw new FormatError('BAD_INPUT', 'a safety number needs two different users');
  const [x, y] = a.userId < b.userId ? [a, b] : [b, a];
  const groups = [...fingerprintOf(x.userId, x.publicKeys, provider), ...fingerprintOf(y.userId, y.publicKeys, provider)];
  const digits = groups.join('');
  return { groups, digits, text: groups.join(' '), qrPayload: `mxe2ee1:safety:${digits}` };
}

const normalise = (s: string): string => s.trim().replace(/^mxe2ee1:safety:/, '').replace(/[\s-]+/g, '');
/** Whether two safety numbers (spaced text, bare digits or the QR payload) are the same. Never throws on odd input: it is false. */
export function compareSafetyNumbers(x: string, y: string): boolean {
  if (typeof x !== 'string' || typeof y !== 'string') return false;
  const a = normalise(x), b = normalise(y);
  if (!/^\d{60}$/.test(a) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
