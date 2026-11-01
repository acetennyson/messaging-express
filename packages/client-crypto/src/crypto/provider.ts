/**
 * The seam between the wire format and the actual cryptography. Everything above this file depends only on this interface;
 * a different implementation (a native binding, or a ratchet library for v2) is a new file, not a rewrite.
 * All keys are raw bytes: X25519 keys are 32 bytes, symmetric keys are 32 bytes, nonces are 24 bytes.
 */
export interface CryptoProvider {
  /** A fresh X25519 key pair (private key: 32 random bytes; public key derived from it). */
  generateKeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array };
  /** Public key for a private key. */
  publicKeyFor(privateKey: Uint8Array): Uint8Array;
  /** X25519. Throws if the result is all zero (a low-order public key). */
  ecdh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  /** HKDF-SHA256 with an EMPTY salt (RFC 5869: a string of zeros). */
  hkdf(ikm: Uint8Array, info: Uint8Array, length: number): Uint8Array;
  /** XChaCha20-Poly1305. Returns ciphertext || 16-byte tag. */
  aeadEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;
  /** Throws DecryptError on any authentication failure. */
  aeadDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array;
  /** Cryptographically secure random bytes. Never Math.random. */
  randomBytes(length: number): Uint8Array;
  /** Argon2id. `m` is in KiB. */
  argon2id(password: Uint8Array, salt: Uint8Array, params: { m: number; t: number; p: number; dkLength: number }): Promise<Uint8Array>;
}
