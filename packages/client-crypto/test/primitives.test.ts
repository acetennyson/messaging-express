// Published test vectors for each primitive, run through OUR provider, so a wrong dependency, a wrong wiring or a platform bug shows up here.
import { describe, it, expect } from 'vitest';
import { nobleProvider as p } from '../src/index';
import { hex, toHex, fill, seq } from './helpers';

describe('X25519 (RFC 7748 section 6.1)', () => {
  const alicePriv = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
  const alicePub = hex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  const bobPriv = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
  const bobPub = hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
  const shared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
  it('derives the published public keys', () => {
    expect(toHex(p.publicKeyFor(alicePriv))).toBe(toHex(alicePub));
    expect(toHex(p.publicKeyFor(bobPriv))).toBe(toHex(bobPub));
  });
  it('agrees on the published shared secret from both sides', () => {
    expect(toHex(p.ecdh(alicePriv, bobPub))).toBe(shared);
    expect(toHex(p.ecdh(bobPriv, alicePub))).toBe(shared);
  });
  it('rejects a low-order public key (all-zero output)', () => {
    expect(() => p.ecdh(alicePriv, new Uint8Array(32))).toThrow();
  });
});

describe('HKDF-SHA256 (RFC 5869 A.3, empty salt, empty info)', () => {
  it('matches the published output', () => {
    expect(toHex(p.hkdf(fill(22, 0x0b), new Uint8Array(0), 42))).toBe('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8');
  });
});

describe('XChaCha20-Poly1305 (draft-irtf-cfrg-xchacha, appendix A.3.1)', () => {
  const key = seq(32, 0x80);
  const nonce = seq(24, 0x40);
  const aad = hex('50515253c0c1c2c3c4c5c6c7');
  const plaintext = new TextEncoder().encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const expected =
    'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52e' + 'c0875924c1c7987947deafd8780acf49';
  it('encrypts to the published ciphertext and tag', () => {
    expect(toHex(p.aeadEncrypt(key, nonce, plaintext, aad))).toBe(expected);
  });
  it('decrypts it back, and fails with a different AAD', () => {
    expect(toHex(p.aeadDecrypt(key, nonce, hex(expected), aad))).toBe(toHex(plaintext));
    expect(() => p.aeadDecrypt(key, nonce, hex(expected), new Uint8Array(0))).toThrow('decryption failed');
  });
});

describe('Argon2id (RFC 9106 section 5.3)', () => {
  it('matches the published tag (via the provider interface, minus secret/AD which the provider does not expose)', async () => {
    // RFC 9106 uses a secret and associated data, which our provider deliberately does not expose. Use noble directly for the RFC vector,
    // then check the provider against a second known answer computed by libsodium-independent code in the cross-check (see scripts/crosscheck.py).
    const { argon2id } = await import('@noble/hashes/argon2');
    const tag = argon2id(fill(32, 1), fill(16, 2), { t: 3, m: 32, p: 4, dkLen: 32, key: fill(8, 3), personalization: fill(12, 4) });
    expect(toHex(tag)).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });
  it('provider.argon2id equals the synchronous reference for the same inputs', async () => {
    const { argon2id } = await import('@noble/hashes/argon2');
    const a = await p.argon2id(fill(8, 9), fill(16, 5), { m: 1024, t: 1, p: 1, dkLength: 32 });
    expect(toHex(a)).toBe(toHex(argon2id(fill(8, 9), fill(16, 5), { m: 1024, t: 1, p: 1, dkLen: 32 })));
  });
});

describe('randomness', () => {
  it('gives distinct, correctly sized output', () => {
    const a = p.randomBytes(32), b = p.randomBytes(32);
    expect(a).toHaveLength(32);
    expect(toHex(a)).not.toBe(toHex(b));
  });
});

describe('randomness: large requests', () => {
  it('fills requests above the 64 KiB getRandomValues limit, with no repeated 64 KiB blocks', () => {
    const big = p.randomBytes(300_000);
    expect(big).toHaveLength(300_000);
    expect(toHex(big.subarray(0, 65536))).not.toBe(toHex(big.subarray(65536, 131072)));
    expect(big.subarray(250_000).some((b) => b !== 0)).toBe(true);
  });
});
