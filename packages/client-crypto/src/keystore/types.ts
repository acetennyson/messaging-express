/**
 * Where a device's private key and the conversation keys live. Pluggable: use `memoryKeyStore()` (Node, tests), `indexedDbKeyStore()`
 * (browsers, from `@messaging-express/client-crypto/stores/indexeddb`), or implement this yourself (OS keychain, secure enclave, an
 * encrypted file) and prove it behaves with `runKeyStoreConformance` from `@messaging-express/client-crypto/testing`.
 *
 * Contract (the conformance suite checks every point):
 * - Keys are non-empty strings of at most 1024 characters; values are `Uint8Array` (empty is allowed). Anything else rejects.
 * - `set` and `get` copy: changing a buffer you passed in or got out never changes what is stored.
 * - `get` of a missing key resolves `null`; `delete` of a missing key resolves normally.
 * - `list(prefix)` resolves the keys that start with `prefix` (all keys if omitted), sorted ascending.
 * - Writes are durable once the promise resolves (for persistent stores).
 *
 * Security: a key store holds raw secrets. The built-in stores do NOT encrypt at rest; the IndexedDB one is exactly as safe as the
 * origin's storage (anything running in your page, a browser extension with access, or someone with the device profile can read it).
 * Bring your own store backed by something stronger if your threat model needs it.
 */
export interface CryptoKeyStore {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export const MAX_KEY_LENGTH = 1024;
