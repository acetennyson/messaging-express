import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fingerprintOf, safetyNumberOf, compareSafetyNumbers, MalformedResponseError, ParticipantHasNoDeviceError, FormatError, nobleProvider, toBase64Url } from '../src/index';
import { makeWorld, secureUser, linkSecondDevice } from './world';

const V = JSON.parse(readFileSync(fileURLToPath(new URL('./vectors/safety.json', import.meta.url)), 'utf8'));
const key = (n: number) => nobleProvider.generateKeyPair().publicKey.map((b, i) => (i === 0 ? n : b));

describe('fingerprint and safety number (frozen vectors, also verified by scripts/crosscheck.py)', () => {
  it('match the vectors', () => {
    for (const t of V.fingerprints) expect(fingerprintOf(t.userId, t.publicKeys)).toEqual(t.groups);
    for (const t of V.safetyNumbers) expect(safetyNumberOf(t.a, t.b).text).toBe(t.text);
  });
  it('is 6 groups of 5 digits per user, 12 for a pair, and the pair is the same from either side', () => {
    const a = { userId: 'a', publicKeys: [key(1)] }, b = { userId: 'b', publicKeys: [key(2), key(3)] };
    const ab = safetyNumberOf(a, b), ba = safetyNumberOf(b, a);
    expect(ab.groups).toHaveLength(12); expect(ab.digits).toMatch(/^\d{60}$/);
    expect(ab.text).toBe(ba.text);
    expect(ab.qrPayload).toBe(`mxe2ee1:safety:${ab.digits}`);
  });
  it('ignores key order and duplicates, and changes with any device or user change', () => {
    const k1 = key(1), k2 = key(2), k3 = key(3);
    expect(fingerprintOf('u', [k1, k2])).toEqual(fingerprintOf('u', [k2, k1, k2]));
    expect(fingerprintOf('u', [k1, k2])).not.toEqual(fingerprintOf('u', [k1, k2, k3]));
    expect(fingerprintOf('u', [k1, k2])).not.toEqual(fingerprintOf('u', [k1]));
    expect(fingerprintOf('u', [k1])).not.toEqual(fingerprintOf('v', [k1]));
    expect(fingerprintOf('u', [toBase64Url(k1)])).toEqual(fingerprintOf('u', [k1]));
  });
  it('refuses nonsense input', () => {
    expect(() => fingerprintOf('', [key(1)])).toThrow(FormatError);
    expect(() => fingerprintOf('u\0x', [key(1)])).toThrow(FormatError);
    expect(() => fingerprintOf('u', [])).toThrow(FormatError);
    expect(() => fingerprintOf('u', [new Uint8Array(31)])).toThrow(FormatError);
    expect(() => safetyNumberOf({ userId: 'a', publicKeys: [key(1)] }, { userId: 'a', publicKeys: [key(2)] })).toThrow(FormatError);
  });
  it('compareSafetyNumbers accepts spaced text, bare digits and the QR payload, and is false for anything else', () => {
    const n = safetyNumberOf({ userId: 'a', publicKeys: [key(1)] }, { userId: 'b', publicKeys: [key(2)] });
    expect(compareSafetyNumbers(n.text, n.digits)).toBe(true);
    expect(compareSafetyNumbers(n.qrPayload, n.text.replace(/ /g, '-'))).toBe(true);
    expect(compareSafetyNumbers(n.text, n.text.slice(0, -1) + (n.text.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(compareSafetyNumbers(n.text, n.text.slice(0, -2))).toBe(false);
    expect(compareSafetyNumbers('', '')).toBe(false);
    expect(compareSafetyNumbers(null as never, n.text)).toBe(false);
  });
});

describe('crypto.safety', () => {
  async function pair() {
    const w = makeWorld();
    const alice = await secureUser(w), bob = await secureUser(w);
    return { w, alice, bob };
  }
  it('both people see the same number; it starts unverified', async () => {
    const { alice, bob } = await pair();
    const a = await alice.client.crypto.safety!.forUser(bob.id), b = await bob.client.crypto.safety!.forUser(alice.id);
    expect(a.text).toBe(b.text);
    expect(a.status).toBe('unverified');
    expect(a.theirs.deviceIds).toHaveLength(1);
  });
  it('verify stores the number only when what the other person read out matches', async () => {
    const { alice, bob } = await pair();
    const A = alice.client.crypto.safety!, B = bob.client.crypto.safety!;
    const theirs = (await B.forUser(alice.id)).text;
    expect(await A.verify(bob.id, theirs.slice(0, -1) + (theirs.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(await A.status(bob.id)).toBe('unverified');
    expect(await A.verify(bob.id, theirs)).toBe(true);
    expect(await A.status(bob.id)).toBe('verified');
    expect(await alice.store.get(`verified/${bob.id}`)).not.toBeNull();
    await A.unverify(bob.id);
    expect(await A.status(bob.id)).toBe('unverified');
  });
  it('a new device on either side turns "verified" into "changed" until confirmed again', async () => {
    const { w, alice, bob } = await pair();
    const A = alice.client.crypto.safety!, B = bob.client.crypto.safety!;
    await A.verify(bob.id, (await B.forUser(alice.id)).text);
    await linkSecondDevice(w, bob);
    expect(await A.status(bob.id)).toBe('changed');
    expect((await A.forUser(bob.id)).theirs.deviceIds).toHaveLength(2);
    await linkSecondDevice(w, alice);
    expect(await A.verify(bob.id, (await B.forUser(alice.id)).text)).toBe(true);
    expect(await A.status(bob.id)).toBe('verified');
  });
  it('a server showing Alice a device Bob does not have makes the numbers differ (split view detected)', async () => {
    const w = makeWorld();
    const rogue = toBase64Url(nobleProvider.generateKeyPair().publicKey);
    let bobId = '';
    const lying: typeof fetch = async (i, init) => {
      const r = await w.mock.fetch(i, init);
      if (!String(typeof i === 'string' ? i : (i as Request).url).includes('/devices?')) return r;
      const j = await r.json();
      j.data.push({ id: 'dddddddd-0000-4000-8000-000000000001', userId: bobId, publicKey: rogue, isPrimary: false, deviceName: 'rogue' });
      return new Response(JSON.stringify(j), { status: r.status, headers: r.headers });
    };
    const alice = await secureUser(w, { fetch: lying }), bob = await secureUser(w);
    bobId = bob.id;
    const a = await alice.client.crypto.safety!.forUser(bob.id), b = await bob.client.crypto.safety!.forUser(alice.id);
    expect(compareSafetyNumbers(a.text, b.text)).toBe(false);
    expect(await alice.client.crypto.safety!.verify(bob.id, b.text)).toBe(false);
  });
  it('a user with no device cannot be compared', async () => {
    const w = makeWorld();
    const alice = await secureUser(w), ghost = await secureUser(w, { register: false });
    const e = await alice.client.crypto.safety!.forUser(ghost.id).catch((x) => x);
    expect(e).toBeInstanceOf(ParticipantHasNoDeviceError);
    expect(e.userIds).toEqual([ghost.id]);
  });
  it('is absent without a userId', () => {
    const w = makeWorld();
    expect(w.clientFor(w.mock.tokenFor(w.mock.addUser())).crypto.safety).toBeUndefined();
  });
});

describe('device lists from the server are checked before use', () => {
  const tamper = (w: ReturnType<typeof makeWorld>, edit: (list: any[]) => unknown, only = '/devices?'): typeof fetch => async (i, init) => {
    const r = await w.mock.fetch(i, init);
    if ((init?.method ?? 'GET') !== 'GET' || !String(typeof i === 'string' ? i : (i as Request).url).includes(only)) return r;
    const j = await r.json();
    return new Response(JSON.stringify({ ...j, data: edit(j.data) }), { status: r.status, headers: r.headers });
  };
  it.each<[string, (l: any[]) => unknown]>([
    ['a short public key', (l: any[]) => l.map((d) => ({ ...d, publicKey: d.publicKey.slice(0, 40) }))],
    ['a key that is not base64url', (l: any[]) => l.map((d) => ({ ...d, publicKey: '!'.repeat(43) }))],
    ['the same device twice', (l: any[]) => [...l, ...l]],
    ['a missing field', (l: any[]) => l.map(({ userId, ...d }: any) => d)],
    ['not an array', () => ({ nope: true })],
  ])('rejects %s', async (_n, edit) => {
    const w = makeWorld();
    const bob = await secureUser(w);
    const alice = await secureUser(w, { fetch: tamper(w, edit) });
    await expect(alice.client.crypto.devices.list([bob.id])).rejects.toBeInstanceOf(MalformedResponseError);
    const before = w.mock.calls.filter((c) => c.method === 'POST').length;
    await expect(alice.sec.createSecureConversation({ participantIds: [bob.id] })).rejects.toBeInstanceOf(MalformedResponseError);
    expect(w.mock.calls.filter((c) => c.method === 'POST').length).toBe(before); // nothing was created or wrapped
  });
  it('rejects a bad conversation device list before any key is sealed for it', async () => {
    const w = makeWorld();
    const alice = await secureUser(w, { fetch: tamper(w, (l) => l.map((d: any) => ({ ...d, publicKey: 'AAAA' })), '/devices') });
    const bob = await secureUser(w);
    const id = (await bob.sec.createSecureConversation({ participantIds: [alice.id] })).id;
    await alice.sec.refreshKeys(id);
    const posts = () => w.mock.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/keys')).length, before = posts();
    // GET /conversations/:id/devices is what the re-keying engine trusts; a malformed answer is an error, never a wrap
    const errs: unknown[] = [];
    alice.rekey.onError((e) => errs.push(e.error));
    await alice.rekey.handle('participant.added', { conversationId: id, userId: 'dddddddd-0000-4000-8000-000000000009' });
    await alice.rekey.handle('keys.requested', { conversationId: id, requestingDeviceId: 'dddddddd-0000-4000-8000-000000000009' });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((e) => e instanceof MalformedResponseError)).toBe(true);
    expect(posts()).toBe(before);
  });
});
