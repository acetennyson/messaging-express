import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { memoryKeyStore, scopedKeyStore, scopePrefix, clearKeyStore, keyNames } from '../src/index';
import { indexedDbKeyStore } from '../src/stores/indexeddb';
import { runKeyStoreConformance, keyStoreConformanceCases } from '../src/testing/index';

const b = (...n: number[]) => Uint8Array.from(n);

async function conformance(name: string, options: Parameters<typeof runKeyStoreConformance>[0]) {
  describe(`${name} passes the key store conformance suite`, () => {
    it('every case', async () => {
      const results = await runKeyStoreConformance(options);
      expect(results.length).toBeGreaterThanOrEqual(keyStoreConformanceCases.length - 1);
      const failed = results.filter((r) => !r.ok);
      expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    });
  });
}

await conformance('memoryKeyStore', { create: () => memoryKeyStore() });
{
  let n = 0;
  const factory = new IDBFactory();
  const names = new Map<unknown, string>();
  await conformance('indexedDbKeyStore (fake-indexeddb)', {
    create: () => { const dbName = `t${n++}`; const s = indexedDbKeyStore({ factory, dbName }); names.set(s, dbName); return s; },
    reopen: (s) => indexedDbKeyStore({ factory, dbName: names.get(s)! }),
    cleanup: (s) => (s as any).close?.(),
  });
}

describe('scopedKeyStore: accounts and servers never share keys', () => {
  it('two users on one origin are isolated, in both directions, including list', async () => {
    const base = memoryKeyStore();
    const a = scopedKeyStore(base, { baseUrl: 'https://api.example.com', userId: 'user-a' });
    const c = scopedKeyStore(base, { baseUrl: 'https://api.example.com', userId: 'user-b' });
    await a.set('device', b(1)); await c.set('device', b(2));
    expect(await a.get('device')).toEqual(b(1)); expect(await c.get('device')).toEqual(b(2));
    await a.delete('device');
    expect(await a.get('device')).toBeNull(); expect(await c.get('device')).toEqual(b(2));
    expect(await a.list()).toEqual([]); expect(await c.list()).toEqual(['device']);
  });
  it('two servers are isolated; scheme/case/trailing slash/path of the same origin are the same server', async () => {
    const base = memoryKeyStore();
    const x = scopedKeyStore(base, { baseUrl: 'https://api.example.com', userId: 'u' });
    const sameServer = scopedKeyStore(base, { baseUrl: 'HTTPS://API.example.com/api/v1/', userId: 'u' });
    const other = scopedKeyStore(base, { baseUrl: 'https://staging.example.com', userId: 'u' });
    await x.set('k', b(1));
    expect(await sameServer.get('k')).toEqual(b(1));
    expect(await other.get('k')).toBeNull();
  });
  it('a user id that looks like another scope cannot reach its keys (no prefix collisions)', async () => {
    const base = memoryKeyStore();
    const victim = scopedKeyStore(base, { baseUrl: 'https://a.test', userId: 'alice' });
    await victim.set('device', b(5));
    for (const evil of ['alice/', 'alice/device', 'alice%2F', '../alice', 'ali']) {
      const s = scopedKeyStore(base, { baseUrl: 'https://a.test', userId: evil });
      expect(await s.get('device')).toBeNull(); expect(await s.list()).toEqual([]);
    }
    expect(new Set(['alice', 'alice/', 'ali'].map((u) => scopePrefix({ baseUrl: 'https://a.test', userId: u }))).size).toBe(3);
  });
  it('a scoped store passes the conformance suite too', async () => {
    const base = memoryKeyStore();
    let n = 0;
    const results = await runKeyStoreConformance({ create: () => scopedKeyStore(base, { baseUrl: 'https://a.test', userId: `u${n++}` }) });
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });
  it('requires a baseUrl and a userId', () => {
    expect(() => scopedKeyStore(memoryKeyStore(), { baseUrl: '', userId: 'u' })).toThrow(TypeError);
    expect(() => scopedKeyStore(memoryKeyStore(), { baseUrl: 'https://a.test', userId: '' })).toThrow(TypeError);
  });
  it('clearKeyStore wipes one account without touching another', async () => {
    const base = memoryKeyStore();
    const a = scopedKeyStore(base, { baseUrl: 'https://a.test', userId: 'a' }); const c = scopedKeyStore(base, { baseUrl: 'https://a.test', userId: 'c' });
    await a.set('device', b(1)); await a.set(keyNames.conversationKey('conv/1', 2), b(2)); await c.set('device', b(3));
    expect(await clearKeyStore(a)).toBe(2);
    expect(await a.list()).toEqual([]); expect(await c.get('device')).toEqual(b(3));
  });
  it('key names are collision-free for awkward conversation ids', () => {
    expect(keyNames.conversationKey('a/b', 1)).not.toBe(keyNames.conversationKey('a', 1));
    expect(keyNames.conversationKey('a/b', 1).startsWith(keyNames.conversationKeyPrefix('a/b'))).toBe(true);
    expect(keyNames.conversationKey('a', 1).startsWith(keyNames.conversationKeyPrefix('a/b'))).toBe(false);
  });
});

describe('a deliberately broken store is caught by the suite', () => {
  it('aliasing store fails the copy cases', async () => {
    const m = new Map<string, Uint8Array>();
    const broken = { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: Uint8Array) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); }, list: async (p = '') => [...m.keys()].filter((k) => k.startsWith(p)).sort() };
    const results = await runKeyStoreConformance({ create: () => { m.clear(); return broken; } });
    const failed = results.filter((r) => !r.ok).map((r) => r.name);
    expect(failed.some((n) => n.includes('copies its input'))).toBe(true);
    expect(failed.some((n) => n.includes('get returns a copy'))).toBe(true);
    expect(failed.some((n) => n.includes('rejects bad keys'))).toBe(true);
  });
});
