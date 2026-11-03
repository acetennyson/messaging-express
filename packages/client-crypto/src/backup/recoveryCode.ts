import type { CryptoProvider } from '../crypto/provider';
import { nobleProvider } from '../crypto/noble';
import { InvalidRecoveryCodeError } from './errors';

// Crockford base32: no I, L, O, U, so a code read aloud or copied by hand is hard to get wrong.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAYLOAD = 32, CHECK = 4;
const utf8 = (s: string) => new TextEncoder().encode(s);

function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
const checkOf = (payload: string, p: CryptoProvider) => base32(p.hkdf(utf8(payload), utf8('mx-e2ee-v1|recovery-code-check'), 3)).slice(0, CHECK);
const group = (s: string) => s.match(/.{1,4}/g)!.join('-');

/** A fresh recovery code: 160 random bits as 32 characters plus 4 check characters, in groups of four: `ABCD-EFGH-…-WXYZ`. */
export function generateRecoveryCode(provider: CryptoProvider = nobleProvider): string {
  const payload = base32(provider.randomBytes(20));
  return group(payload + checkOf(payload, provider));
}

/** Canonical text of a typed code (upper-case, no separators, O->0, I/L->1). Does not check anything. */
function canon(input: string): string {
  return input.normalize('NFKC').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/**
 * What to feed the key derivation. A recovery code (36 characters of the code alphabet) is checked and reduced to its 32-character payload,
 * so dashes, spaces, case and look-alike letters do not matter; a wrong check throws InvalidRecoveryCodeError. Anything else is a passphrase.
 */
export function classifySecret(input: string, provider: CryptoProvider = nobleProvider): { kind: 'recovery-code'; secret: string } | { kind: 'passphrase'; secret: string } {
  if (typeof input !== 'string') throw new TypeError('secret must be a string');
  const c = canon(input);
  if (c.length === PAYLOAD + CHECK && [...c].every((ch) => ALPHABET.includes(ch))) {
    const payload = c.slice(0, PAYLOAD);
    if (checkOf(payload, provider) !== c.slice(PAYLOAD)) throw new InvalidRecoveryCodeError();
    return { kind: 'recovery-code', secret: payload };
  }
  return { kind: 'passphrase', secret: input };
}
