import type { CryptoKeyStore } from '../keystore/types';
import { byCodeUnit, checkKey, checkPrefix, checkValue } from '../keystore/validate';

export interface IndexedDbKeyStoreOptions {
  /** Database name. Default "mx-e2ee-keys". Use a different name per app if several share an origin. */
  dbName?: string;
  /** Inject an IDBFactory (tests use `fake-indexeddb`). Defaults to the global `indexedDB`. */
  factory?: IDBFactory;
  /** Ask the browser not to evict this origin's storage (losing keys means losing message history). Best effort; default true. */
  requestPersistentStorage?: boolean;
}

const STORE = 'keys';

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** IndexedDB-backed store for browsers and workers. Values are stored as raw bytes (not encrypted at rest). Import from `@messaging-express/client-crypto/stores/indexeddb`. */
export function indexedDbKeyStore(options: IndexedDbKeyStoreOptions = {}): CryptoKeyStore & { close(): void } {
  const dbName = options.dbName ?? 'mx-e2ee-keys';
  let dbPromise: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      const factory = options.factory ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
      if (!factory) return Promise.reject(new Error('IndexedDB is not available in this environment (use memoryKeyStore() or supply a factory)'));
      if (options.requestPersistentStorage !== false && typeof navigator !== 'undefined') void navigator.storage?.persist?.().catch(() => undefined);
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = factory.open(dbName, 1);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { db.close(); dbPromise = null; }; // another tab upgrading must not be blocked by us
          resolve(db);
        };
        req.onerror = () => reject(req.error ?? new Error('could not open IndexedDB'));
        req.onblocked = () => reject(new Error('IndexedDB open was blocked by another connection'));
      }).catch((e) => { dbPromise = null; throw e; });
    }
    return dbPromise;
  };

  return {
    async get(key) {
      checkKey(key);
      const db = await open();
      const v = await wrap(db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
      return v instanceof Uint8Array ? v.slice() : v ? new Uint8Array(v as ArrayBuffer) : null;
    },
    async set(key, value) {
      checkKey(key); checkValue(value);
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value.slice(), key); // structured clone copies; slice() also guards against a subarray's wider buffer being stored
      await done(tx);
    },
    async delete(key) {
      checkKey(key);
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      await done(tx);
    },
    async list(prefix) {
      const p = checkPrefix(prefix);
      const db = await open();
      const all = (await wrap(db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys())) as IDBValidKey[];
      return all.filter((k): k is string => typeof k === 'string' && k.startsWith(p)).sort(byCodeUnit);
    },
    close() {
      void dbPromise?.then((db) => db.close()).catch(() => undefined);
      dbPromise = null;
    },
  };
}
