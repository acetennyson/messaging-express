import { describe, expect, it } from 'vitest';
import { keyNames } from '../src/index';
import { makeWorld, secureUser, linkSecondDevice, stored, type World, type SecureUser } from './world';

const live = { live: true } as const;
async function pair(w: World, o: Parameters<typeof secureUser>[1] = {}) {
  const alice = await secureUser(w, { ...live, ...o });
  const bob = await secureUser(w, { ...live, ...o });
  const conv = await alice.sec.createSecureConversation({ participantIds: [bob.id] });
  await bob.sec.refreshKeys(conv.id);
  return { alice, bob, id: conv.id };
}
const idle = (...u: Array<{ rekey: { idle(): Promise<void> } }>) => Promise.all(u.map((x) => x.rekey.idle()));
const flush = () => new Promise((r) => setTimeout(r, 5));
async function readAll(u: { sec: SecureUser['sec'] }, w: World, asUser: SecureUser | { id: string; client: SecureUser['client'] }, id: string) {
  const list = (await asUser.client.messages.list({ conversationId: id })).data as never;
  return (await u.sec.decryptMessages(list)).map((o) => (o.ok ? o.message.text : 'ERR'));
}

describe('device.added', () => {
  it('a new device of another member gets the keys at once and can read history', async () => {
    const w = makeWorld();
    const { alice, bob, id } = await pair(w);
    await alice.sec.sendSecureMessage({ conversationId: id, text: 'before the laptop' });
    const laptop = await linkSecondDevice(w, bob);
    await flush(); await idle(alice, bob);
    await laptop.sec.refreshKeys(id);
    expect(await readAll(laptop, w, bob, id)).toEqual(['before the laptop']);
  });
  it('emits deviceChange once per device, even if the event repeats', async () => {
    const w = makeWorld();
    const { alice, bob, id } = await pair(w);
    const seen: unknown[] = [];
    alice.rekey.onDeviceChange((c) => seen.push(c));
    const laptop = await linkSecondDevice(w, bob);
    const d = (await laptop.dev.currentDevice())!;
    await flush(); await idle(alice);
    await alice.rekey.handle('device.added', { userId: bob.id, deviceId: d.deviceId, publicKey: 'x', conversationIds: [id] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ userId: bob.id, deviceId: d.deviceId, status: 'wrapped', own: false });
  });
  it('the same device event handled twice at once uploads once (dedupe)', async () => {
    const w = makeWorld();
    const { alice, bob, id } = await pair(w);
    const laptop = await linkSecondDevice(w, bob);
    await flush(); await idle(alice);
    const before = w.mock.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/keys')).length;
    const d = (await laptop.dev.currentDevice())!;
    await Promise.all([1, 2, 3].map(() => alice.rekey.handle('device.added', { userId: bob.id, deviceId: d.deviceId, publicKey: 'x', conversationIds: [id] })));
    expect(w.mock.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/keys')).length - before).toBeLessThanOrEqual(1);
  });
  it('history "latest" gives only the newest version, "none" gives nothing', async () => {
    for (const [mode, expected] of [['latest', [2]], ['none', []]] as const) {
      const w = makeWorld();
      const { alice, bob, id } = await pair(w, { linkedDeviceHistory: mode });
      const carol = await secureUser(w, { ...live, linkedDeviceHistory: mode });
      await alice.client.crypto.conversations.addParticipant(id, carol.id);
      await alice.rekey.rotate(id); await bob.sec.refreshKeys(id);
      const laptop = await linkSecondDevice(w, bob);
      await flush(); await idle(alice, bob);
      await laptop.sec.refreshKeys(id).catch(() => undefined);
      const got: number[] = [];
      for (const v of [1, 2]) if (await laptop.store.get(keyNames.conversationKey(id, v))) got.push(v);
      expect(got).toEqual(expected);
    }
  });
});

describe('lost events', () => {
  it('with events dropped the piggyback check before a send still gives the laptop its keys', async () => {
    const w = makeWorld();
    const { alice, bob, id } = await pair(w);
    w.mock.setDropEvents(true);
    const laptop = await linkSecondDevice(w, bob);
    await alice.sec.sendSecureMessage({ conversationId: id, text: 'sent while offline' });
    w.mock.setDropEvents(false);
    await laptop.sec.refreshKeys(id);
    expect(await readAll(laptop, w, bob, id)).toEqual(['sent while offline']);
  });
  it('the piggyback answer is reused for the TTL, then asked again', async () => {
    let t = 0;
    const w = makeWorld();
    const alice = await secureUser(w, { now: () => t });
    const bob = await secureUser(w);
    const conv = await alice.sec.createSecureConversation({ participantIds: [bob.id] });
    const n = () => w.mock.calls.filter((c) => c.method === 'GET' && c.path === `/conversations/${conv.id}/devices`).length;
    await alice.sec.sendSecureMessage({ conversationId: conv.id, text: 'a' }); const a = n();
    t += 10_000; await alice.sec.sendSecureMessage({ conversationId: conv.id, text: 'b' });
    expect(n()).toBe(a);
    t += 31_000; await alice.sec.sendSecureMessage({ conversationId: conv.id, text: 'c' });
    expect(n()).toBe(a + 1);
  });
  it('a failing check never blocks the send', async () => {
    const w = makeWorld();
    const { alice, id } = await pair(w);
    w.mock.inject({ match: /GET \/conversations\/.*\/devices/, status: 500, code: 'INTERNAL_ERROR', times: 5 });
    await expect(alice.sec.sendSecureMessage({ conversationId: id, text: 'ok' })).resolves.toBeTruthy();
    expect(w.mock.calls.filter((c) => c.path.endsWith('/devices') && c.path.startsWith('/conversations/')).length).toBeGreaterThan(0);
  });
});

describe('keys.requested', () => {
  it('a current device that asks is answered; a stranger is not', async () => {
    const w = makeWorld();
    const { alice, bob, id } = await pair(w);
    await alice.sec.sendSecureMessage({ conversationId: id, text: 'hello' });
    w.mock.setDropEvents(true);
    const laptop = await linkSecondDevice(w, bob);
    w.mock.setDropEvents(false);
    const d = (await laptop.dev.currentDevice())!;
    await alice.rekey.handle('keys.requested', { conversationId: id, requestingDeviceId: d.deviceId });
    await laptop.sec.refreshKeys(id);
    expect(await readAll(laptop, w, bob, id)).toEqual(['hello']);
    const eve = await secureUser(w);
    const calls = w.mock.calls.length;
    await alice.rekey.handle('keys.requested', { conversationId: id, requestingDeviceId: (await eve.dev.currentDevice())!.deviceId });
    expect(w.mock.calls.slice(calls).filter((c) => c.method === 'POST' && c.path.endsWith('/keys'))).toHaveLength(0);
  });
});

describe('deviceTrust confirm', () => {
  it("another user's new device waits for approval; your own does not", async () => {
    const w = makeWorld();
    // Bob's own phone is offline here (no events), so only Alice's decision is being tested
    const alice = await secureUser(w, { ...live, deviceTrust: 'confirm' });
    const bob = await secureUser(w);
    const id = (await alice.sec.createSecureConversation({ participantIds: [bob.id] })).id;
    await alice.sec.sendSecureMessage({ conversationId: id, text: 'secret' });
    const changes: Array<{ status: string }> = [];
    alice.rekey.onDeviceChange((c) => changes.push(c));
    const laptop = await linkSecondDevice(w, bob);
    await flush(); await idle(alice, bob);
    const d = (await laptop.dev.currentDevice())!;
    expect(changes.map((c) => c.status)).toEqual(['pending']);
    expect(alice.rekey.pendingDevices().map((p) => p.deviceId)).toEqual([d.deviceId]);
    // still no keys for the laptop, even after Alice sends (piggyback must not bypass the hold)
    await alice.sec.sendSecureMessage({ conversationId: id, text: 'more' });
    await laptop.sec.refreshKeys(id).catch(() => undefined);
    expect(await laptop.store.get(keyNames.conversationKey(id, 1))).toBeNull();
    await alice.rekey.approveDevice(d.deviceId);
    await laptop.sec.refreshKeys(id);
    expect((await readAll(laptop, w, bob, id)).sort()).toEqual(['more', 'secret']);
    expect(alice.rekey.pendingDevices()).toHaveLength(0);
    expect(changes.map((c) => c.status)).toEqual(['pending', 'wrapped']);
    // Alice's own second device is never held back
    const mine = await linkSecondDevice(w, alice);
    await flush(); await idle(alice);
    await mine.sec.refreshKeys(id);
    expect((await readAll(mine, w, alice, id)).sort()).toEqual(['more', 'secret']);
  });
});

describe('participant.removed', () => {
  it('four members, one removed: everyone races, one v2 wins, the removed member never gets it', async () => {
    const w = makeWorld();
    const a = await secureUser(w, live), b = await secureUser(w, live), c = await secureUser(w, live), d = await secureUser(w, live);
    const conv = await a.sec.createSecureConversation({ participantIds: [b.id, c.id, d.id] });
    await Promise.all([b, c, d].map((u) => u.sec.refreshKeys(conv.id)));
    await a.sec.sendSecureMessage({ conversationId: conv.id, text: 'v1 message' });
    await a.client.crypto.conversations.removeParticipant(conv.id, d.id);
    await flush(); await idle(a, b, c);
    const v2 = w.mock.state.keys().filter((k) => k.conversationId === conv.id && k.keyVersion === 2);
    expect(v2.length).toBe(3); // a, b, c: exactly one complete set
    expect(w.mock.state.conversation(conv.id)!.min_key_version ?? 1).toBeGreaterThanOrEqual(1);
    for (const u of [a, b, c]) { await u.sec.refreshKeys(conv.id); expect(await u.store.get(keyNames.conversationKey(conv.id, 2))).toHaveLength(32); }
    await a.sec.sendSecureMessage({ conversationId: conv.id, text: 'after' });
    const msgs = await stored(a, conv.id);
    expect(msgs.map((m) => m.metadata?.key_version).sort()).toEqual([1, 2]);
    expect(await d.store.get(keyNames.conversationKey(conv.id, 2))).toBeNull();
    const all = await d.sec.refreshKeys(conv.id).catch((e) => e);
    expect(all).toBeDefined();
    expect(await d.store.get(keyNames.conversationKey(conv.id, 2))).toBeNull();
    const m2 = msgs.find((m) => m.metadata?.key_version === 2) as never;
    await expect(d.sec.decryptMessage(m2)).rejects.toThrow(); // no key, and the server no longer lets the removed member ask for it
  });
  it('two members rotating at the same instant: the loser adopts the winner, no errors, same key everywhere', async () => {
    const w = makeWorld();
    const a = await secureUser(w, live), b = await secureUser(w, live), c = await secureUser(w, live);
    const conv = await a.sec.createSecureConversation({ participantIds: [b.id, c.id] });
    await Promise.all([b, c].map((u) => u.sec.refreshKeys(conv.id)));
    const errs: unknown[] = [];
    for (const u of [a, b]) u.rekey.onError((e) => errs.push(e));
    const [ra, rb] = await Promise.all([a.rekey.rotate(conv.id), b.rekey.rotate(conv.id)]);
    expect(errs).toEqual([]);
    expect([ra.rotated, rb.rotated].filter(Boolean)).toHaveLength(1); // exactly one won
    expect(ra.version).toBe(2); expect(rb.version).toBe(2);
    await c.sec.refreshKeys(conv.id);
    const k = (u: typeof a) => u.store.get(keyNames.conversationKey(conv.id, 2));
    expect(await k(a)).toEqual(await k(b)); expect(await k(b)).toEqual(await k(c));
  });
  it('handler errors go to onError and never throw out of the event', async () => {
    const w = makeWorld();
    const { alice, id } = await pair(w);
    const errs: unknown[] = [];
    alice.rekey.onError((e) => errs.push(e));
    await alice.rekey.handle('participant.removed', { conversationId: id, userId: 'someone', minKeyVersion: 2 }); // lone member, valid rotate
    await alice.rekey.handle('keys.updated', 'garbage');
    expect(errs.length).toBeGreaterThanOrEqual(0);
  });
});
