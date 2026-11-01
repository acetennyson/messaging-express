import { x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { argon2idAsync } from '@noble/hashes/argon2';
import { randomBytes } from '@noble/hashes/utils';
import { DecryptError } from '../format/errors';
import type { CryptoProvider } from './provider';

/** The default provider, built on the audited @noble libraries. */
export const nobleProvider: CryptoProvider = {
  generateKeyPair() {
    const privateKey = randomBytes(32);
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
  },
  publicKeyFor(privateKey) {
    return x25519.getPublicKey(privateKey);
  },
  ecdh(privateKey, publicKey) {
    const shared = x25519.getSharedSecret(privateKey, publicKey); // noble rejects the all-zero result itself; the check below is belt and braces
    let acc = 0;
    for (let i = 0; i < shared.length; i++) acc |= shared[i];
    if (acc === 0) throw new Error('invalid public key (low-order point)');
    return shared;
  },
  hkdf(ikm, info, length) {
    return hkdf(sha256, ikm, new Uint8Array(0), info, length);
  },
  aeadEncrypt(key, nonce, plaintext, aad) {
    return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  },
  aeadDecrypt(key, nonce, ciphertext, aad) {
    try {
      return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
    } catch {
      throw new DecryptError();
    }
  },
  randomBytes(length) {
    return randomBytes(length);
  },
  async argon2id(password, salt, { m, t, p, dkLength }) {
    return argon2idAsync(password, salt, { m, t, p, dkLen: dkLength, maxmem: m * 1024 + 4 * 1024 * 1024 });
  },
};
