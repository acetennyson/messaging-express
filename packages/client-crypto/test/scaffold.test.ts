import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME } from '../src/index';

describe('scaffold (C0)', () => {
  it('loads', () => {
    expect(PACKAGE_NAME).toBe('@messaging-express/client-crypto');
  });

  it('pins its crypto dependencies to exact versions (no ^ or ~)', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    for (const [name, range] of Object.entries(pkg.dependencies as Record<string, string>)) {
      expect(range, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('the pinned primitives load and agree with their published behaviour (X25519 shared secret, XChaCha20-Poly1305 round trip)', async () => {
    const { x25519 } = await import('@noble/curves/ed25519');
    const { xchacha20poly1305 } = await import('@noble/ciphers/chacha');
    const a = x25519.utils.randomPrivateKey();
    const b = x25519.utils.randomPrivateKey();
    const s1 = x25519.getSharedSecret(a, x25519.getPublicKey(b));
    const s2 = x25519.getSharedSecret(b, x25519.getPublicKey(a));
    expect(Buffer.from(s1).equals(Buffer.from(s2))).toBe(true);
    const nonce = new Uint8Array(24).fill(7);
    const ct = xchacha20poly1305(s1, nonce).encrypt(new TextEncoder().encode('hi'));
    expect(new TextDecoder().decode(xchacha20poly1305(s2, nonce).decrypt(ct))).toBe('hi');
  });
});
