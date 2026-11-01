import type { CryptoKeyStore } from './types';
import { byCodeUnit, checkKey, checkPrefix, checkValue } from './validate';

/** In-memory store: nothing survives a reload or a restart. For Node scripts, servers-side tests and demos. */
export function memoryKeyStore(): CryptoKeyStore {
  const map = new Map<string, Uint8Array>();
  return {
    async get(key) {
      const v = map.get(checkKey(key));
      return v ? v.slice() : null;
    },
    async set(key, value) {
      map.set(checkKey(key), checkValue(value).slice());
    },
    async delete(key) {
      map.delete(checkKey(key));
    },
    async list(prefix) {
      const p = checkPrefix(prefix);
      return [...map.keys()].filter((k) => k.startsWith(p)).sort(byCodeUnit);
    },
  };
}
