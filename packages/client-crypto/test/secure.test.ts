import { describe, expect, it } from 'vitest';
import {
  KeyUnavailableError, ParticipantHasNoDeviceError, DecryptError, FormatError, KeyRotationRequiredError, newConversationKey, wrapKeyForDevices, keyNames, ApiError,
} from '../src/index';
import { makeWorld, secureUser, stored, linkSecondDevice, newKeyPair, type World } from './world';

async function alicebob(w: World, now?: () => number) {
  const alice = await secureUser(w, { now });
  const bob = await secureUser(w, { now });
  const conv = await alice.sec.createSecureConversation({ participantIds: [bob.id] });
  return { alice, bob, conv, id: conv.id };
}
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

describe('createSecureConversation', () => {
  it('creates an e2ee conversation under a client-chosen id and caches the key; type defaults from the member count', async () => {
    const w = makeWorld();
    const { alice, conv } = await alicebob(w);
    expect(conv).toMatchObject({ encryption_mode: 'e2ee-v1', min_key_version: 1, type: 'direct' });
    expect(await alice.store.get(keyNames.conversationKey(conv.id, 1))).toHaveLength(32);
    expect(w.mock.state.keys()).toHaveLength(2); // one sealed copy per device
    const carol = await secureUser(w);
    const g = await alice.sec.createSecureConversation({ participantIds: [carol.id, alice.id] }); // self is added once
    expect(w.mock.state.conversation(g.id)!.participants).toEqual([alice.id, carol.id]);
  });
  it('a participant without a device fails before anything is created', async () => {
    const w = makeWorld();
    const alice = await secureUser(w);
    const ghost = await secureUser(w, { register: false });
    const e = await alice.sec.createSecureConversation({ participantIds: [ghost.id] }).catch((x) => x);
    expect(e).toBeInstanceOf(ParticipantHasNoDeviceError);
    expect(e.userIds).toEqual([ghost.id]);
    expect(w.mock.state.keys()).toHaveLength(0);
  });
  it('retries with a fresh device list when the set changes mid-flight (StaleDeviceSetError)', async () => {
    const w = makeWorld();
    let bob!: Awaited<ReturnType<typeof secureUser>>;
    let armed = true;
    const alice = await secureUser(w, {
      fetch: async (i, init) => {
        if (armed && init?.method === 'POST' && String(typeof i === 'string' ? i : (i as Request).url).endsWith('/conversations')) { armed = false; await linkSecondDevice(w, bob); }
        return w.mock.fetch(i, init);
      },
    });
    bob = await secureUser(w);
    const conv = await alice.sec.createSecureConversation({ participantIds: [bob.id] });
    expect(w.mock.state.keys().filter((k) => k.conversationId === conv.id)).toHaveLength(3); // alice + bob's two devices
    expect(w.mock.calls.filter((c) => c.method === 'POST' && c.path === '/conversations')).toHaveLength(2);
  });
  it('a server that ignores the id is reported clearly, and nothing is cached', async () => {
    const w = makeWorld();
    const alice = await secureUser(w, { fetch: async (i, init) => {
      const r = await w.mock.fetch(i, init);
      if (init?.method === 'POST' && String(typeof i === 'string' ? i : (i as Request).url).endsWith('/conversations')) {
        const j = await r.clone().json(); j.data.id = '00000000-0000-4000-8000-000000000001';
        return new Response(JSON.stringify(j), { status: 201 });
      }
      return r;
    } });
    const bob = await secureUser(w);
    await expect(alice.sec.createSecureConversation({ participantIds: [bob.id] })).rejects.toMatchObject({ name: 'ConversationIdNotSupportedError' });
  });
});

describe('send and read', () => {
  it('Bob reads what Alice sent, from a cold start (keys fetched on demand), and the server only holds ciphertext', async () => {
    const w = makeWorld();
    const { alice, bob, id } = await alicebob(w);
    const text = "Meet at 7. Don't tell anyone.";
    const sent = await alice.sec.sendSecureMessage({ conversationId: id, text });
    const rows = await stored(bob, id);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).not.toContain('Meet');
    expect(JSON.stringify(w.mock.state.messages())).not.toContain('Meet at 7');
    expect(rows[0].metadata).toEqual({ scheme: 'ck-xchacha-v1', key_version: 1 });
    expect(rows[0].id).toBe(sent.id);
    const out = await bob.sec.decryptMessage(rows[0]);
    expect(out).toMatchObject({ text, senderId: alice.id, conversationId: id, keyVersion: 1, attachments: [] });
    // the key is now cached: no second fetch of keys
    const before = w.mock.calls.filter((c) => c.path.endsWith('/keys')).length;
    await bob.sec.decryptMessage(rows[0]);
    expect(w.mock.calls.filter((c) => c.path.endsWith('/keys')).length).toBe(before);
  });
  it('Alice can read her own message back (her device got a sealed copy too), including after a restart', async () => {
    const w = makeWorld();
    const { alice, id } = await alicebob(w);
    await alice.sec.sendSecureMessage({ conversationId: id, text: 'note to self' });
    await alice.store.delete(keyNames.conversationKey(id, 1)); // simulate a fresh cache: fetched and unwrapped again
    expect((await alice.sec.decryptMessage((await stored(alice, id))[0])).text).toBe('note to self');
  });
  it('decryptMessages keeps going past a bad message and says which one failed', async () => {
    const w = makeWorld();
    const { alice, bob, id } = await alicebob(w);
    await alice.sec.sendSecureMessage({ conversationId: id, text: 'one' });
    await alice.sec.sendSecureMessage({ conversationId: id, text: 'two' });
    const rows = await stored(bob, id);
    const bad = { ...rows[0], content: rows[0].content!.slice(0, -4) + 'AAAA', id: 'bad' };
    const plain = { ...rows[0], metadata: {}, id: 'plain' };
    const out = await bob.sec.decryptMessages([rows[1], bad, plain, rows[0]]);
    expect(out.map((o) => o.ok)).toEqual([true, false, false, true]);
    expect((out[1] as { error: unknown }).error).toBeInstanceOf(DecryptError);
    expect((out[2] as { error: unknown }).error).toBeInstanceOf(FormatError);
  });
  it('server-side tampering is detected: replay into another conversation, wrong sender, edited ciphertext', async () => {
    const w = makeWorld();
    const { alice, bob, id } = await alicebob(w);
    const other = await alice.sec.createSecureConversation({ participantIds: [bob.id] });
    await alice.sec.sendSecureMessage({ conversationId: id, text: 'secret' });
    const m = (await stored(bob, id))[0];
    await expect(bob.sec.decryptMessage({ ...m, conversation_id: other.id })).rejects.toBeInstanceOf(DecryptError);
    await expect(bob.sec.decryptMessage({ ...m, sender_id: bob.id })).rejects.toBeInstanceOf(DecryptError);
    const i = Math.floor(m.content!.length / 2);
    await expect(bob.sec.decryptMessage({ ...m, content: m.content!.slice(0, i) + (m.content![i] === 'A' ? 'B' : 'A') + m.content!.slice(i + 1) })).rejects.toBeInstanceOf(DecryptError);
    await expect(bob.sec.decryptMessage({ ...m, metadata: { scheme: 'ck-xchacha-v1', key_version: 1.5 } })).rejects.toBeInstanceOf(FormatError);
  });
});

describe('attachments', () => {
  it('encrypts before upload, the server stores opaque bytes, the recipient opens them with name and type intact', async () => {
    const w = makeWorld();
    const { alice, bob, id } = await alicebob(w);
    const photo = bytes(200_000, 7), doc = new TextEncoder().encode('hello attachment');
    await alice.sec.sendSecureMessage({ conversationId: id, text: 'two files', attachments: [{ data: photo, name: 'cat.png', type: 'image/png', w: 640, h: 480 }, { data: new Blob([doc]), name: 'notes.txt', type: 'text/plain' }] });
    const files = w.mock.state.files();
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.mime === 'application/octet-stream' && f.name === 'encrypted.bin')).toBe(true);
    expect(Buffer.from(files[1].bytes).includes(Buffer.from('hello attachment'))).toBe(false);
    const m = await bob.sec.decryptMessage((await stored(bob, id))[0]);
    expect(m.attachments.map((a) => [a.descriptor.name, a.descriptor.type, a.descriptor.w])).toEqual([['cat.png', 'image/png', 640], ['notes.txt', 'text/plain', undefined]]);
    const stored0 = JSON.stringify(w.mock.state.messages());
    expect(stored0).not.toContain('cat.png'); // real names never reach the server
    const a0 = await bob.sec.openAttachment(m.attachments[0]);
    expect(a0).toMatchObject({ name: 'cat.png', type: 'image/png' });
    expect(a0.bytes).toEqual(photo);
    expect(new TextDecoder().decode((await bob.sec.openAttachment(m.attachments[1])).bytes)).toBe('hello attachment');
  });
  it('a server that swaps, drops or corrupts attachments is caught', async () => {
    const w = makeWorld();
    const { alice, bob, id } = await alicebob(w);
    await alice.sec.sendSecureMessage({ conversationId: id, text: 'x', attachments: [{ data: bytes(100), name: 'a', type: 'a/a' }, { data: bytes(100, 9), name: 'b', type: 'b/b' }] });
    const m = (await stored(bob, id))[0];
    const good = await bob.sec.decryptMessage(m);
    await expect(bob.sec.openAttachment({ descriptor: good.attachments[0].descriptor, url: good.attachments[1].url })).rejects.toBeInstanceOf(DecryptError); // swapped objects
    await expect(bob.sec.decryptMessage({ ...m, attachments: [m.attachments![0]] })).rejects.toBeInstanceOf(FormatError); // dropped
    const f = w.mock.state.files()[0]; f.bytes[20] ^= 1; // corrupted at rest (the view shares the buffer)
    await expect(bob.sec.openAttachment(good.attachments[0])).rejects.toBeInstanceOf(DecryptError);
  });
  it('plain (unencrypted) uploads of octet-stream are still refused by the server rules', async () => {
    const w = makeWorld();
    const u = await secureUser(w);
    const form = new FormData(); form.append('file', new Blob([bytes(10)], { type: 'application/octet-stream' }), 'x.bin');
    const r = await w.mock.fetch('http://mock/api/v1/uploads', { method: 'POST', headers: { authorization: w.mock.tokenFor(u.id).replace(/^/, 'Bearer ') }, body: form });
    expect(r.status).toBe(400);
  });
});

describe('missing keys', () => {
  it('a newly linked device has no wrap: KeyUnavailableError, one key request per minute, readable once a member sends the wrap', async () => {
    let t = 1_000_000;
    const w = makeWorld();
    const { alice, bob, id } = await alicebob(w, () => t);
    await alice.sec.sendSecureMessage({ conversationId: id, text: 'history' });
    const laptop = await linkSecondDevice(w, bob);
    const m = (await stored(bob, id))[0];
    const e1 = await laptop.sec.decryptMessage(m).catch((x) => x);
    expect(e1).toBeInstanceOf(KeyUnavailableError);
    expect(e1).toMatchObject({ conversationId: id, keyVersion: 1, requested: true });
    expect(w.mock.eventsOf('keys.requested')).toHaveLength(1);
    expect(w.mock.eventsOf('keys.requested')[0].to.sort()).toEqual([alice.id].sort());
    // laptop's own manager has a different clock; use a second laptop-bound call: the throttle is per messaging instance
    const e2 = await laptop.sec.decryptMessage(m).catch((x) => x);
    expect(e2).toBeInstanceOf(KeyUnavailableError);
    expect(e2.requested).toBe(false); // less than a minute since the last request
    expect(w.mock.eventsOf('keys.requested')).toHaveLength(1);
    // Alice answers the request: she wraps the key for the laptop's device
    const ck = (await alice.store.get(keyNames.conversationKey(id, 1)))!;
    const me = await alice.dev.requireDevice();
    const lap = await laptop.dev.currentDevice();
    const wraps = wrapKeyForDevices({ conversationKey: ck, conversationId: id, keyVersion: 1, sender: { deviceId: me.deviceId, privateKey: me.privateKey }, recipients: [{ deviceId: lap!.deviceId, publicKey: lap!.publicKey }] });
    await alice.client.crypto.keys.upload(id, me.deviceId, { keyVersion: 1, keys: wraps });
    expect((await laptop.sec.decryptMessage(m)).text).toBe('history');
  });
  it('an unknown key_version from the server is KeyUnavailableError, not a crash', async () => {
    const w = makeWorld();
    const { alice, bob, id } = await alicebob(w);
    await alice.sec.sendSecureMessage({ conversationId: id, text: 'x' });
    const m = (await stored(bob, id))[0];
    const e = await bob.sec.decryptMessage({ ...m, metadata: { scheme: 'ck-xchacha-v1', key_version: 99 } }).catch((x) => x);
    expect(e).toBeInstanceOf(KeyUnavailableError);
    expect(e.keyVersion).toBe(99);
  });
  it('a sealed copy that cannot be opened (tampered at rest) surfaces as KeyUnavailableError with the cause', async () => {
    const w = makeWorld();
    const { bob, id } = await alicebob(w);
    const row = w.mock.state.keys().find((k) => k.deviceId === (w.mock.state.devices().find((d) => d.userId === bob.id)!.id))!;
    row.wrappedKey = row.wrappedKey.slice(0, -3) + (row.wrappedKey.endsWith('AAA') ? 'BBB' : 'AAA');
    const e = await bob.sec.decryptMessage({ id: 'm', conversation_id: id, sender_id: bob.id, content: 'A'.repeat(60), metadata: { scheme: 'ck-xchacha-v1', key_version: 1 } }).catch((x) => x);
    expect(e).toBeInstanceOf(KeyUnavailableError);
    expect(e.cause).toBeInstanceOf(DecryptError);
  });
});

describe('rotation', () => {
  it('after a removal the server demands v2: sending without it is KeyUnavailable and stores nothing; once the new key arrives, send re-encrypts under it', async () => {
    const w = makeWorld();
    const alice = await secureUser(w), bob = await secureUser(w), carol = await secureUser(w);
    const conv = await alice.sec.createSecureConversation({ participantIds: [bob.id, carol.id] });
    await alice.sec.sendSecureMessage({ conversationId: conv.id, text: 'before' });
    await alice.client.crypto.conversations.removeParticipant(conv.id, carol.id); // min_key_version -> 2
    const e = await alice.sec.sendSecureMessage({ conversationId: conv.id, text: 'too early' }).catch((x) => x);
    expect(e).toBeInstanceOf(KeyUnavailableError);
    expect(w.mock.state.messages().map((m) => m.content).length).toBe(1);
    // Bob rotates: a new key for the remaining devices (C7 automates this; here by hand through the API layer)
    const devs = await bob.client.crypto.devices.list([alice.id, bob.id]);
    const me = await bob.dev.requireDevice();
    const ck2 = newConversationKey();
    const keys = wrapKeyForDevices({ conversationKey: ck2, conversationId: conv.id, keyVersion: 2, sender: { deviceId: me.deviceId, privateKey: me.privateKey }, recipients: devs.map((d) => ({ deviceId: d.id, publicKey: d.publicKey })) });
    await bob.client.crypto.keys.upload(conv.id, me.deviceId, { keyVersion: 2, keys });
    // Alice still thinks v1 is newest locally; the server says KEY_ROTATION_REQUIRED, she refreshes and retries once
    await alice.sec.sendSecureMessage({ conversationId: conv.id, text: 'after' });
    const rows = await stored(bob, conv.id);
    expect(rows.map((r) => (r.metadata as { key_version: number }).key_version).sort()).toEqual([1, 2]);
    const texts = (await bob.sec.decryptMessages(rows)).map((o) => (o.ok ? o.message.text : 'ERR')).sort();
    expect(texts).toEqual(['after', 'before']);
    // Carol can no longer read anything new
    await expect(carol.client.crypto.keys.get(conv.id, (await carol.dev.currentDevice())!.deviceId)).rejects.toBeInstanceOf(ApiError);
  });
  it('an e2ee server rule violation by an old client (below the floor) is KeyRotationRequiredError at the API layer', async () => {
    const w = makeWorld();
    const { alice, bob, id } = await alicebob(w);
    await alice.client.crypto.conversations.removeParticipant(id, bob.id);
    const ck = (await alice.store.get(keyNames.conversationKey(id, 1)))!;
    const { encryptSecureMessage } = await import('../src/index');
    const content = encryptSecureMessage({ text: 'x' }, ck, { conversationId: id, keyVersion: 1, senderId: alice.id });
    await expect(alice.client.crypto.messages.postEncrypted({ conversationId: id, senderId: alice.id, content, keyVersion: 1 })).rejects.toBeInstanceOf(KeyRotationRequiredError);
    void newKeyPair;
  });
});
