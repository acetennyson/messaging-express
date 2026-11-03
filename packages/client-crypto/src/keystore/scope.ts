import type { CryptoKeyStore } from './types';
import { checkKey, checkPrefix } from './validate';

export interface KeyStoreScope {
  /** The API origin (e.g. "https://api.example.com"). Keys for two different servers never mix. */
  baseUrl: string;
  /** The Messaging Express user id. Keys for two different accounts on one origin never mix. */
  userId: string;
}

function originOf(baseUrl: string): string {
  try { return new URL(baseUrl).origin.toLowerCase(); } catch { return String(baseUrl).trim().toLowerCase().replace(/\/+$/, ''); }
}

/** The exact prefix a scope uses. Exposed so tooling can find (or wipe) one account's keys in a shared store. */
export function scopePrefix(scope: KeyStoreScope): string {
  if (!scope?.baseUrl || !scope?.userId) throw new TypeError('scope needs a baseUrl and a userId');
  // encodeURIComponent turns "/" into %2F, so no origin or user id can ever contain the separator and two scopes cannot collide by prefix.
  return `mx-e2ee/v1/${encodeURIComponent(originOf(scope.baseUrl))}/${encodeURIComponent(scope.userId)}/`;
}

/** Wraps any key store so everything it reads and writes lives under one (baseUrl, userId). `list` and keys come back without the prefix. */
export function scopedKeyStore(store: CryptoKeyStore, scope: KeyStoreScope): CryptoKeyStore {
  const prefix = scopePrefix(scope);
  const full = (key: string) => prefix + checkKey(key);
  return {
    get: (key) => store.get(full(key)),
    set: (key, value) => store.set(full(key), value),
    delete: (key) => store.delete(full(key)),
    async list(p) {
      const names = await store.list(prefix + checkPrefix(p));
      return names.map((n) => n.slice(prefix.length));
    },
  };
}

/** Delete every key in the store (use on a scoped store to log one account out of a device). */
export async function clearKeyStore(store: CryptoKeyStore): Promise<number> {
  const keys = await store.list();
  for (const k of keys) await store.delete(k);
  return keys.length;
}

/** The names C5 onward use inside a scoped store. Centralised so every layer and every store implementation agrees. */
export const keyNames = {
  /** { deviceId, privateKey, publicKey }, written by device registration or restore. */
  device: 'device',
  /** A key pair generated for a device that is not registered (or linked) yet. Survives a crash between generating and registering. */
  devicePending: 'device-pending',
  /** Present after this device learned it was revoked; cleared by the next registration or link. */
  deviceRevoked: 'device-revoked',
  /** Per conversation, the device ids this device has seen and given keys to (or approved): the basis of the device-trust policy. */
  knownDevices: 'known-devices',
  /** The safety number the user last confirmed with another user (see crypto.safety). */
  verified: (otherUserId: string) => `verified/${encodeURIComponent(otherUserId)}`,
  /** The conversation key for one (conversation, version). */
  conversationKey: (conversationId: string, keyVersion: number) => `ck/${encodeURIComponent(conversationId)}/${keyVersion}`,
  conversationKeyPrefix: (conversationId: string) => `ck/${encodeURIComponent(conversationId)}/`,
} as const;
