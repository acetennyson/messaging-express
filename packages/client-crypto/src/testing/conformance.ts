import type { CryptoKeyStore } from '../keystore/types';

export interface ConformanceResult { name: string; ok: boolean; error?: string }
export interface ConformanceOptions {
  /** Return a fresh, EMPTY store each time. */
  create: () => CryptoKeyStore | Promise<CryptoKeyStore>;
  /** For persistent stores: open a NEW instance over the SAME storage as `store` (as after a page reload). Omit for in-memory stores. */
  reopen?: (store: CryptoKeyStore) => CryptoKeyStore | Promise<CryptoKeyStore>;
  /** Called after each case with the store it used (close connections, delete databases). */
  cleanup?: (store: CryptoKeyStore) => void | Promise<void>;
}

const bytes = (...n: number[]) => Uint8Array.from(n);
const eq = (a: Uint8Array | null, b: Uint8Array) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
async function rejects(fn: () => Promise<unknown>, msg: string): Promise<void> {
  try { await fn(); } catch { return; }
  throw new Error(msg);
}
const same = <T,>(a: T[], b: T[], msg: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

type Case = { name: string; persistent?: boolean; run: (s: CryptoKeyStore, o: ConformanceOptions) => Promise<void> };

export const keyStoreConformanceCases: Case[] = [
  { name: 'get of a missing key resolves null', run: async (s) => { assert((await s.get('nope')) === null, 'expected null'); } },
  { name: 'set then get returns the same bytes', run: async (s) => { await s.set('k', bytes(1, 2, 3)); assert(eq(await s.get('k'), bytes(1, 2, 3)), 'bytes differ'); } },
  { name: 'set overwrites', run: async (s) => { await s.set('k', bytes(1)); await s.set('k', bytes(2, 2)); assert(eq(await s.get('k'), bytes(2, 2)), 'not overwritten'); } },
  { name: 'set copies its input (later changes to the buffer do not change the store)', run: async (s) => { const v = bytes(1, 2, 3); await s.set('k', v); v[0] = 99; assert(eq(await s.get('k'), bytes(1, 2, 3)), 'store aliased the input'); } },
  { name: 'set stores only the bytes of a subarray view, not its whole buffer', run: async (s) => { const big = bytes(9, 9, 1, 2, 3, 9, 9); await s.set('k', big.subarray(2, 5)); assert(eq(await s.get('k'), bytes(1, 2, 3)), 'stored the wider buffer'); } },
  { name: 'get returns a copy (changing it does not change the store)', run: async (s) => { await s.set('k', bytes(1, 2, 3)); const a = (await s.get('k'))!; a[0] = 99; assert(eq(await s.get('k'), bytes(1, 2, 3)), 'get aliased the stored bytes'); } },
  { name: 'an empty value round-trips and is not confused with a missing key', run: async (s) => { await s.set('e', new Uint8Array(0)); const v = await s.get('e'); assert(v !== null && v.length === 0, 'empty value lost'); } },
  { name: 'a 1 MB value round-trips', run: async (s) => { const v = new Uint8Array(1 << 20).map((_, i) => (i * 31) & 255); await s.set('big', v); assert(eq(await s.get('big'), v), 'large value corrupted'); } },
  { name: 'delete removes a key and deleting a missing key is fine', run: async (s) => { await s.set('k', bytes(1)); await s.delete('k'); assert((await s.get('k')) === null, 'still there'); await s.delete('k'); await s.delete('never-existed'); } },
  { name: 'list returns all keys sorted, and honours a prefix', run: async (s) => {
    for (const k of ['b/2', 'a/1', 'b/1', 'c']) await s.set(k, bytes(1));
    same(await s.list(), ['a/1', 'b/1', 'b/2', 'c'], 'list()');
    same(await s.list('b/'), ['b/1', 'b/2'], "list('b/')");
    same(await s.list('zzz'), [], "list('zzz')");
    await s.delete('b/1');
    same(await s.list('b/'), ['b/2'], 'list after delete');
  } },
  { name: 'keys with unicode, slashes, pipes, spaces and percent signs are distinct and exact', run: async (s) => {
    const keys = ['é', 'é', 'a/b', 'a|b', 'a b', 'a%2Fb', '日本語', '😀'];
    for (const [i, k] of keys.entries()) await s.set(k, bytes(i));
    for (const [i, k] of keys.entries()) assert(eq(await s.get(k), bytes(i)), `key ${JSON.stringify(k)} mixed up with another`);
    assert((await s.list()).length === keys.length, 'a key was merged with another');
  } },
  { name: 'a 512-character key is accepted', run: async (s) => { const k = 'x'.repeat(512); await s.set(k, bytes(1)); assert(eq(await s.get(k), bytes(1)), 'long key lost'); } },
  { name: 'rejects bad keys and bad values', run: async (s) => {
    for (const k of ['', 'x'.repeat(1025), 5, null, undefined] as any[]) { await rejects(() => s.set(k, bytes(1)), `set accepted key ${String(k).slice(0, 8)}`); await rejects(() => s.get(k), `get accepted key ${String(k).slice(0, 8)}`); }
    for (const v of ['text', [1, 2, 3], null, undefined, 7, new ArrayBuffer(4)] as any[]) await rejects(() => s.set('k', v), `set accepted value ${Object.prototype.toString.call(v)}`);
    assert((await s.get('k')) === null, 'a rejected write still left data');
  } },
  { name: 'concurrent writes to different keys all land', run: async (s) => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => s.set(`k${String(i).padStart(2, '0')}`, bytes(i))));
    assert((await s.list()).length === 50, 'lost a concurrent write');
    for (let i = 0; i < 50; i++) assert(eq(await s.get(`k${String(i).padStart(2, '0')}`), bytes(i)), `wrong value for k${i}`);
  } },
  { name: 'concurrent writes to one key end with exactly one of the written values', run: async (s) => {
    await Promise.all([1, 2, 3, 4, 5].map((n) => s.set('k', bytes(n, n))));
    const v = await s.get('k'); assert(v !== null && v.length === 2 && v[0] === v[1] && v[0] >= 1 && v[0] <= 5, 'torn or invented value');
  } },
  { name: 'data survives reopening the store (persistent stores only)', persistent: true, run: async (s, o) => {
    await s.set('kept', bytes(7, 7)); await s.set('gone', bytes(1)); await s.delete('gone');
    const again = await o.reopen!(s);
    try { assert(eq(await again.get('kept'), bytes(7, 7)), 'value lost across reopen'); assert((await again.get('gone')) === null, 'a deleted key came back'); same(await again.list(), ['kept'], 'list after reopen'); }
    finally { await o.cleanup?.(again); }
  } },
];

/** Runs every case against stores from `options.create`. Returns one result per case (never throws), so it works in any test runner or in a browser. */
export async function runKeyStoreConformance(options: ConformanceOptions): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  for (const c of keyStoreConformanceCases) {
    if (c.persistent && !options.reopen) continue;
    let store: CryptoKeyStore | undefined;
    try {
      store = await options.create();
      assert((await store.list()).length === 0, 'create() must return an empty store');
      await c.run(store, options);
      results.push({ name: c.name, ok: true });
    } catch (e) {
      results.push({ name: c.name, ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (store) await Promise.resolve(options.cleanup?.(store)).catch(() => undefined);
    }
  }
  return results;
}
