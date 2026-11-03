import { describe, expect, it } from 'vitest';
import {
  ApiError, DeviceExistsError, DeviceInvalidError, DeviceLimitError, DeviceRequiredError, ForbiddenError, KeyExistsError, KeyRotationRequiredError,
  KeysNotReadyError, NotFoundError, PairingNotFoundError, ParticipantHasNoDeviceError, RateLimitedError, StaleDeviceSetError, ValidationError,
  mapApiError, newConversationKey, wrapKeyForDevices, unwrapKey, encryptSecureMessage, decryptSecureMessage, withCrypto, memoryKeyStore,
} from '../src/index';
import { makeWorld, newKeyPair, userWithDevice, type World } from './world';

const uuid = () => globalThis.crypto.randomUUID();
const WRAP = 'A'.repeat(98); // 73 bytes of base64url: shape-valid, opaque to the server

async function pair(w: World) {
  const a = await userWithDevice(w, 'a');
  const b = await userWithDevice(w, 'b');
  return { a, b };
}
/** Real wraps for a new conversation between the given users, created through the API. */
async function createConv(w: World, creator: Awaited<ReturnType<typeof userWithDevice>>, others: Awaited<ReturnType<typeof userWithDevice>>[]) {
  const id = uuid();
  const members = [creator, ...others];
  const devs = await creator.client.crypto.devices.list(members.map((m) => m.id));
  const ck = newConversationKey();
  const keys = wrapKeyForDevices({
    conversationKey: ck, conversationId: id, keyVersion: 1,
    sender: { deviceId: creator.deviceId, privateKey: creator.kp.privateKey },
    recipients: devs.map((d) => ({ deviceId: d.id, publicKey: d.publicKey })),
  });
  const conv = await creator.client.crypto.conversations.createEncrypted(creator.deviceId, { id, type: 'group', participantIds: members.map((m) => m.id), keys });
  return { conv, ck, id };
}

describe('error mapping', () => {
  it('maps every E2EE code, both rate-limit spellings, and passes unknowns through', () => {
    const mk = (code: string, status: number, details?: unknown) => mapApiError(Object.assign(new Error(code), { status, code, details, retryAfter: 7 }));
    expect(mk('DEVICE_REQUIRED', 403)).toBeInstanceOf(DeviceRequiredError);
    expect(mk('DEVICE_INVALID', 403)).toBeInstanceOf(DeviceInvalidError);
    expect(mk('DEVICE_EXISTS', 409)).toBeInstanceOf(DeviceExistsError);
    expect(mk('DEVICE_LIMIT', 409)).toBeInstanceOf(DeviceLimitError);
    expect(mk('PAIRING_NOT_FOUND', 404)).toBeInstanceOf(PairingNotFoundError);
    expect(mk('KEY_EXISTS', 409)).toBeInstanceOf(KeyExistsError);
    expect(mk('KEYS_NOT_READY', 409)).toBeInstanceOf(KeysNotReadyError);
    expect(mk('NOT_FOUND', 404)).toBeInstanceOf(NotFoundError);
    expect(mk('VALIDATION_ERROR', 400)).toBeInstanceOf(ValidationError);
    expect(mk('FORBIDDEN', 403)).toBeInstanceOf(ForbiddenError);
    for (const c of ['RATE_LIMITED', 'RATE_LIMIT_EXCEEDED']) {
      const e = mk(c, 429) as RateLimitedError;
      expect(e).toBeInstanceOf(RateLimitedError);
      expect(e.retryAfter).toBe(7);
    }
    expect((mk('STALE_DEVICE_SET', 409, { deviceIds: ['x', 'y'] }) as StaleDeviceSetError).deviceIds).toEqual(['x', 'y']);
    expect((mk('PARTICIPANT_HAS_NO_DEVICE', 409, { userIds: ['u'] }) as ParticipantHasNoDeviceError).userIds).toEqual(['u']);
    expect((mk('KEY_ROTATION_REQUIRED', 409, { minKeyVersion: 4 }) as KeyRotationRequiredError).minKeyVersion).toBe(4);
    const other = mk('SOMETHING_NEW', 418);
    expect(other).toBeInstanceOf(ApiError);
    expect(other).not.toBeInstanceOf(NotFoundError);
    const plain = new Error('boom');
    expect(mapApiError(plain)).toBe(plain);
    expect(mapApiError('str')).toBe('str');
  });
  it('malformed details never throw', () => {
    expect((mapApiError(Object.assign(new Error('x'), { status: 409, code: 'STALE_DEVICE_SET', details: 'junk' })) as StaleDeviceSetError).deviceIds).toEqual([]);
  });
});

describe('withCrypto', () => {
  it('adds .crypto and leaves the client working; requires a keyStore', () => {
    const w = makeWorld();
    const u = w.user();
    expect(typeof u.client.request).toBe('function');
    expect(typeof u.client.crypto.devices.register).toBe('function');
    expect(Object.isFrozen(u.client.crypto)).toBe(true);
    expect(() => withCrypto(u.client, {} as never)).toThrow(TypeError);
    expect(withCrypto(u.client, { keyStore: memoryKeyStore() }).crypto.keyStore).toBeDefined();
  });
});

describe('devices', () => {
  it('registers a primary; a second registration is DeviceExistsError; unknown user is NotFound', async () => {
    const w = makeWorld();
    const u = await userWithDevice(w);
    const dev = (await u.client.crypto.devices.list([u.id]))[0];
    expect(dev).toMatchObject({ id: u.deviceId, userId: u.id, publicKey: u.kp.publicKeyB64, isPrimary: true, deviceName: 'phone' });
    await expect(u.client.crypto.devices.register({ publicKey: newKeyPair().publicKeyB64 })).rejects.toBeInstanceOf(DeviceExistsError);
    const ghost = w.clientFor(w.mock.tokenFor(uuid()));
    await expect(ghost.crypto.devices.register({ publicKey: newKeyPair().publicKeyB64 })).rejects.toBeInstanceOf(NotFoundError);
  });
  it('rejects a bad key and a bad name with ValidationError', async () => {
    const w = makeWorld();
    const u = w.user();
    await expect(u.client.crypto.devices.register({ publicKey: 'short' })).rejects.toBeInstanceOf(ValidationError);
    await expect(u.client.crypto.devices.register({ publicKey: newKeyPair().publicKeyB64, deviceName: 'x'.repeat(65) })).rejects.toBeInstanceOf(ValidationError);
  });
  it('admin/api tokens cannot use user-only routes', async () => {
    const w = makeWorld();
    await expect(w.admin.crypto.devices.register({ publicKey: newKeyPair().publicKeyB64 })).rejects.toBeInstanceOf(ForbiddenError);
  });
  it('list chunks past 50 ids and dedupes; unknown users yield nothing', async () => {
    const w = makeWorld();
    const u = await userWithDevice(w);
    const ids = [u.id, u.id, ...Array.from({ length: 120 }, () => uuid())];
    w.mock.calls.length = 0;
    const out = await u.client.crypto.devices.list(ids);
    expect(out.map((d) => d.id)).toEqual([u.deviceId]);
    expect(w.mock.calls.filter((c) => c.path === '/devices')).toHaveLength(3); // 121 distinct ids -> 50 + 50 + 21
    await expect(u.client.crypto.devices.list([])).resolves.toEqual([]);
  });
  it('pair then link: the approval is single-use, key-bound and expires', async () => {
    let t = 1_000_000;
    const w = makeWorld({ now: () => t, pairingTtlSeconds: 60 });
    const a = await userWithDevice(w);
    const newKp = newKeyPair();
    const asNew = w.clientFor(w.mock.tokenFor(a.id)); // same user, new device: no X-Device-Id yet
    // not approved yet
    await expect(asNew.crypto.devices.link({ publicKey: newKp.publicKeyB64 })).rejects.toBeInstanceOf(PairingNotFoundError);
    const { expiresAt } = await a.client.crypto.devices.pair(a.deviceId, newKp.publicKeyB64);
    expect(Date.parse(expiresAt)).toBe(t + 60_000);
    // a different key does not claim it, and a failed attempt does not burn it
    await expect(asNew.crypto.devices.link({ publicKey: newKeyPair().publicKeyB64 })).rejects.toBeInstanceOf(PairingNotFoundError);
    const linked = await asNew.crypto.devices.link({ publicKey: newKp.publicKeyB64, deviceName: 'laptop' });
    expect(linked.isPrimary).toBe(false);
    expect(linked.devices.map((d) => d.id)).toEqual([a.deviceId]);
    // single use
    await expect(asNew.crypto.devices.link({ publicKey: newKp.publicKeyB64 })).rejects.toBeInstanceOf(PairingNotFoundError);
    expect((await a.client.crypto.devices.list([a.id])).map((d) => d.isPrimary)).toEqual([true, false]);
    // expiry
    const k3 = newKeyPair();
    await a.client.crypto.devices.pair(a.deviceId, k3.publicKeyB64);
    t += 61_000;
    await expect(asNew.crypto.devices.link({ publicKey: k3.publicKeyB64 })).rejects.toBeInstanceOf(PairingNotFoundError);
  });
  it('only the primary can pair; header is required and checked; an existing key is rejected', async () => {
    const w = makeWorld();
    const a = await userWithDevice(w);
    const k2 = newKeyPair();
    await a.client.crypto.devices.pair(a.deviceId, k2.publicKeyB64);
    const second = await a.client.crypto.devices.link({ publicKey: k2.publicKeyB64 });
    await expect(a.client.crypto.devices.pair(second.id, newKeyPair().publicKeyB64)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(a.client.crypto.devices.pair('', newKeyPair().publicKeyB64)).rejects.toBeInstanceOf(DeviceRequiredError);
    await expect(a.client.crypto.devices.pair(uuid(), newKeyPair().publicKeyB64)).rejects.toBeInstanceOf(DeviceInvalidError);
    await expect(a.client.crypto.devices.pair(a.deviceId, a.kp.publicKeyB64)).rejects.toBeInstanceOf(ValidationError);
    const b = await userWithDevice(w);
    await expect(a.client.crypto.devices.pair(b.deviceId, newKeyPair().publicKeyB64)).rejects.toBeInstanceOf(DeviceInvalidError); // someone else's device
  });
  it('a new approval replaces the previous one (one live approval per user)', async () => {
    const w = makeWorld();
    const a = await userWithDevice(w);
    const k1 = newKeyPair(), k2 = newKeyPair();
    await a.client.crypto.devices.pair(a.deviceId, k1.publicKeyB64);
    await a.client.crypto.devices.pair(a.deviceId, k2.publicKeyB64);
    await expect(a.client.crypto.devices.link({ publicKey: k1.publicKeyB64 })).rejects.toBeInstanceOf(PairingNotFoundError);
    await expect(a.client.crypto.devices.link({ publicKey: k2.publicKeyB64 })).resolves.toBeDefined();
  });
  it('enforces the device limit', async () => {
    const w = makeWorld({ maxDevicesPerUser: 2 });
    const a = await userWithDevice(w);
    const k = newKeyPair();
    await a.client.crypto.devices.pair(a.deviceId, k.publicKeyB64);
    await a.client.crypto.devices.link({ publicKey: k.publicKeyB64 });
    const k3 = newKeyPair();
    await a.client.crypto.devices.pair(a.deviceId, k3.publicKeyB64);
    await expect(a.client.crypto.devices.link({ publicKey: k3.publicKeyB64 })).rejects.toBeInstanceOf(DeviceLimitError);
  });
  it('revoke: own devices only, primary hands over to the oldest, a revoked device is invalid, events fire', async () => {
    const w = makeWorld();
    const a = await userWithDevice(w);
    const k = newKeyPair();
    await a.client.crypto.devices.pair(a.deviceId, k.publicKeyB64);
    const second = await a.client.crypto.devices.link({ publicKey: k.publicKeyB64 });
    const other = await userWithDevice(w);
    await expect(other.client.crypto.devices.revoke(second.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(a.client.crypto.devices.revoke('not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
    const r = await a.client.crypto.devices.revoke(a.deviceId); // the primary revokes itself
    expect(r.id).toBe(a.deviceId);
    expect((await a.client.crypto.devices.list([a.id]))).toMatchObject([{ id: second.id, isPrimary: true }]);
    await expect(a.client.crypto.devices.pair(a.deviceId, newKeyPair().publicKeyB64)).rejects.toBeInstanceOf(DeviceInvalidError);
    expect(w.mock.eventsOf('device.removed').some((e) => e.data.deviceId === a.deviceId)).toBe(true);
    await expect(a.client.crypto.devices.revoke(a.deviceId)).rejects.toBeInstanceOf(NotFoundError); // already revoked
  });
  it('admin reset revokes all devices and the live approval; users cannot call it', async () => {
    const w = makeWorld();
    const a = await userWithDevice(w);
    const k = newKeyPair();
    await a.client.crypto.devices.pair(a.deviceId, k.publicKeyB64);
    await expect(a.client.crypto.devices.resetUser(a.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(w.admin.crypto.devices.resetUser(a.id)).resolves.toEqual({ revoked: 1 });
    expect(await a.client.crypto.devices.list([a.id])).toEqual([]);
    await expect(a.client.crypto.devices.link({ publicKey: k.publicKeyB64 })).rejects.toBeInstanceOf(PairingNotFoundError);
    await expect(w.api.crypto.devices.resetUser(a.id)).resolves.toEqual({ revoked: 0 });
    // after a reset the user can register again
    await expect(a.client.crypto.devices.register({ publicKey: newKeyPair().publicKeyB64 })).resolves.toMatchObject({ isPrimary: true });
  });
  it('device.added reaches the user and co-members of e2ee conversations', async () => {
    const w = makeWorld();
    const { a, b } = await pair(w);
    const c = await userWithDevice(w);
    const { id } = await createConv(w, a, [b]);
    const k = newKeyPair();
    await a.client.crypto.devices.pair(a.deviceId, k.publicKeyB64);
    const linked = await a.client.crypto.devices.link({ publicKey: k.publicKeyB64 });
    expect(linked.conversationIds).toEqual([id]);
    const ev = w.mock.eventsOf('device.added')[0];
    expect(ev.to.sort()).toEqual([a.id, b.id].sort());
    expect(ev.to).not.toContain(c.id);
    expect(ev.data).toMatchObject({ userId: a.id, deviceId: linked.id, publicKey: k.publicKeyB64, conversationIds: [id] });
  });
});

describe('backup', () => {
  const kdf = { v: 1 as const, alg: 'argon2id' as const, m: 19456, t: 2, p: 1, salt: 'A'.repeat(22) };
  it('put / get / replace / delete; GET without one is NotFound', async () => {
    const w = makeWorld();
    const u = w.user(); // no device needed: restore happens before one is selected
    await expect(u.client.crypto.backup.get()).rejects.toBeInstanceOf(NotFoundError);
    const put = await u.client.crypto.backup.put({ blob: 'QUJD', kdf });
    const got = await u.client.crypto.backup.get();
    expect(got).toEqual({ blob: 'QUJD', kdf, updatedAt: put.updatedAt });
    await u.client.crypto.backup.put({ blob: 'REVG', kdf });
    expect((await u.client.crypto.backup.get()).blob).toBe('REVG');
    await expect(u.client.crypto.backup.delete()).resolves.toEqual({ deleted: true });
    await expect(u.client.crypto.backup.get()).rejects.toBeInstanceOf(NotFoundError);
  });
  it('backups are per user', async () => {
    const w = makeWorld();
    const a = w.user(), b = w.user();
    await a.client.crypto.backup.put({ blob: 'QUJD', kdf });
    await expect(b.client.crypto.backup.get()).rejects.toBeInstanceOf(NotFoundError);
  });
  it('rejects unknown kdf fields, bad params, oversize and non-base64url blobs', async () => {
    const w = makeWorld();
    const u = w.user();
    const bad = (x: unknown) => expect(u.client.crypto.backup.put(x as never)).rejects.toBeInstanceOf(ValidationError);
    await bad({ blob: 'QUJD', kdf: { ...kdf, extra: 1 } });
    await bad({ blob: 'QUJD', kdf: { ...kdf, m: 10 } });
    await bad({ blob: 'QUJD', kdf: { ...kdf, alg: 'scrypt' } });
    await bad({ blob: 'QUJD', kdf: { ...kdf, salt: 'AA' } });
    await bad({ blob: 'not base64url!', kdf });
    await bad({ blob: 'A'.repeat(11_000), kdf });
    await bad({ blob: 'QUJD', kdf, extra: true });
  });
});

describe('conversations and keys', () => {
  it('create-with-keys is atomic: a stale or incomplete set leaves nothing behind', async () => {
    const w = makeWorld();
    const { a, b } = await pair(w);
    const id = uuid();
    const devs = await a.client.crypto.devices.list([a.id, b.id]);
    const wrapFor = (ds: typeof devs) => wrapKeyForDevices({ conversationKey: newConversationKey(), conversationId: id, keyVersion: 1, sender: { deviceId: a.deviceId, privateKey: a.kp.privateKey }, recipients: ds.map((d) => ({ deviceId: d.id, publicKey: d.publicKey })) });
    const err = await a.client.crypto.conversations.createEncrypted(a.deviceId, { id, type: 'group', participantIds: [a.id, b.id], keys: wrapFor(devs.slice(0, 1)) }).catch((e) => e);
    expect(err).toBeInstanceOf(StaleDeviceSetError);
    expect([...err.deviceIds].sort()).toEqual(devs.map((d) => d.id).sort());
    expect(w.mock.state.conversation(id)).toBeUndefined();
    expect(w.mock.state.keys()).toHaveLength(0);
    expect(w.mock.events).toHaveLength(0);
    // the corrected set succeeds on the same id
    const conv = await a.client.crypto.conversations.createEncrypted(a.deviceId, { id, type: 'group', participantIds: [a.id, b.id], keys: wrapFor(devs) });
    expect(conv).toMatchObject({ id, encryption_mode: 'e2ee-v1', min_key_version: 1 });
    expect(w.mock.state.keys()).toHaveLength(2);
    expect(w.mock.eventsOf('keys.updated')[0].data).toMatchObject({ conversationId: id, keyVersion: 1 });
  });
  it('a participant with no device is PARTICIPANT_HAS_NO_DEVICE; creator must be a participant; [Dev] header required; id must be unique', async () => {
    const w = makeWorld();
    const { a, b } = await pair(w);
    const nodev = w.user();
    const mk = (over: Record<string, unknown>) => ({ id: uuid(), type: 'group' as const, participantIds: [a.id, b.id], keys: [{ deviceId: a.deviceId, wrappedKey: WRAP, wrappedByDeviceId: a.deviceId }, { deviceId: b.deviceId, wrappedKey: WRAP, wrappedByDeviceId: a.deviceId }], ...over });
    const e1 = await a.client.crypto.conversations.createEncrypted(a.deviceId, mk({ participantIds: [a.id, nodev.id] })).catch((e) => e);
    expect(e1).toBeInstanceOf(ParticipantHasNoDeviceError);
    expect(e1.userIds).toEqual([nodev.id]);
    await expect(a.client.crypto.conversations.createEncrypted(a.deviceId, mk({ participantIds: [b.id] }))).rejects.toBeInstanceOf(ValidationError);
    await expect(a.client.crypto.conversations.createEncrypted('', mk({}))).rejects.toBeInstanceOf(DeviceRequiredError);
    await expect(a.client.crypto.conversations.createEncrypted(b.deviceId, mk({}))).rejects.toBeInstanceOf(DeviceInvalidError);
    await expect(a.client.crypto.conversations.createEncrypted(a.deviceId, mk({ keys: [] }))).rejects.toBeInstanceOf(ValidationError);
    const dup = mk({}); dup.keys[1] = { ...dup.keys[0] };
    await expect(a.client.crypto.conversations.createEncrypted(a.deviceId, dup)).rejects.toBeInstanceOf(ValidationError);
    await expect(a.client.crypto.conversations.createEncrypted(a.deviceId, mk({ keys: [{ deviceId: a.deviceId, wrappedKey: WRAP, wrappedByDeviceId: b.deviceId }, { deviceId: b.deviceId, wrappedKey: WRAP, wrappedByDeviceId: b.deviceId }] }))).rejects.toBeInstanceOf(ValidationError);
    const ok = mk({});
    await a.client.crypto.conversations.createEncrypted(a.deviceId, ok);
    await expect(a.client.crypto.conversations.createEncrypted(a.deviceId, { ...ok })).rejects.toMatchObject({ status: 409, code: 'CONVERSATION_EXISTS' });
  });
  it('flag off: every E2EE route is NotFound', async () => {
    const w = makeWorld({ e2eeEnabled: false });
    const u = w.user();
    await expect(u.client.crypto.devices.register({ publicKey: newKeyPair().publicKeyB64 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(u.client.crypto.devices.list([u.id])).rejects.toBeInstanceOf(NotFoundError);
    await expect(u.client.crypto.backup.get()).rejects.toBeInstanceOf(NotFoundError);
    await expect(w.admin.crypto.devices.resetUser(u.id)).rejects.toBeInstanceOf(NotFoundError);
  });
  it('getKeys returns only rows addressed to the calling device, with the wrapper public key; round-trips to the real key', async () => {
    const w = makeWorld();
    const { a, b } = await pair(w);
    const { id, ck } = await createConv(w, a, [b]);
    const rows = await b.client.crypto.keys.get(id, b.deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ keyVersion: 1, wrappedByDeviceId: a.deviceId, wrappedByPublicKey: a.kp.publicKeyB64 });
    const opened = unwrapKey({ wrappedKey: rows[0].wrappedKey, conversationId: id, keyVersion: 1, wrappedByDeviceId: rows[0].wrappedByDeviceId, senderPublicKey: rows[0].wrappedByPublicKey, recipient: { deviceId: b.deviceId, privateKey: b.kp.privateKey } });
    expect(opened).toEqual(ck);
    const outsider = await userWithDevice(w);
    await expect(outsider.client.crypto.keys.get(id, outsider.deviceId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(a.client.crypto.keys.get(uuid(), a.deviceId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(a.client.crypto.keys.get(id, '')).rejects.toBeInstanceOf(DeviceRequiredError);
  });
  it('uploadKeys: rotation needs the exact set; adding for a new device works; repeats are KeyExists; skipping a version is invalid', async () => {
    const w = makeWorld();
    const { a, b } = await pair(w);
    const { id, ck } = await createConv(w, a, [b]);
    const wrapAll = (ds: { id: string; publicKey: string }[], v: number) => wrapKeyForDevices({ conversationKey: newConversationKey(), conversationId: id, keyVersion: v, sender: { deviceId: a.deviceId, privateKey: a.kp.privateKey }, recipients: ds.map((d) => ({ deviceId: d.id, publicKey: d.publicKey })) });
    const devs = await a.client.crypto.devices.list([a.id, b.id]);
    await expect(a.client.crypto.keys.upload(id, a.deviceId, { keyVersion: 3, keys: wrapAll(devs, 3) })).rejects.toBeInstanceOf(ValidationError);
    await expect(a.client.crypto.keys.upload(id, a.deviceId, { keyVersion: 2, keys: wrapAll(devs.slice(0, 1), 2) })).rejects.toBeInstanceOf(StaleDeviceSetError);
    await expect(a.client.crypto.keys.upload(id, a.deviceId, { keyVersion: 2, keys: wrapAll(devs, 2) })).resolves.toEqual({ inserted: 2 });
    await expect(a.client.crypto.keys.upload(id, a.deviceId, { keyVersion: 2, keys: wrapAll(devs, 2) })).rejects.toBeInstanceOf(KeyExistsError);
    // a newly linked device gets a wrap of an EXISTING version
    const k = newKeyPair();
    await b.client.crypto.devices.pair(b.deviceId, k.publicKeyB64);
    const linked = await b.client.crypto.devices.link({ publicKey: k.publicKeyB64 });
    const wraps = wrapKeyForDevices({ conversationKey: ck, conversationId: id, keyVersion: 1, sender: { deviceId: a.deviceId, privateKey: a.kp.privateKey }, recipients: [{ deviceId: linked.id, publicKey: k.publicKeyB64 }] });
    await expect(a.client.crypto.keys.upload(id, a.deviceId, { keyVersion: 1, keys: wraps })).resolves.toEqual({ inserted: 1 });
    // the next rotation must now include the new device
    await expect(a.client.crypto.keys.upload(id, a.deviceId, { keyVersion: 3, keys: wrapAll(devs, 3) })).rejects.toBeInstanceOf(StaleDeviceSetError);
    // a device of a non-participant can never be a target of an existing version
    const outsider = await userWithDevice(w);
    const bad = wrapKeyForDevices({ conversationKey: ck, conversationId: id, keyVersion: 1, sender: { deviceId: a.deviceId, privateKey: a.kp.privateKey }, recipients: [{ deviceId: outsider.deviceId, publicKey: outsider.kp.publicKeyB64 }] });
    await expect(a.client.crypto.keys.upload(id, a.deviceId, { keyVersion: 1, keys: bad })).rejects.toBeInstanceOf(ValidationError);
  });
  it('requestKeys notifies the other participants only', async () => {
    const w = makeWorld();
    const { a, b } = await pair(w);
    const { id } = await createConv(w, a, [b]);
    await expect(b.client.crypto.keys.request(id, b.deviceId, 1)).resolves.toEqual({ requested: true });
    await b.client.crypto.keys.request(id, b.deviceId);
    const evs = w.mock.eventsOf('keys.requested');
    expect(evs[0]).toMatchObject({ to: [a.id], data: { conversationId: id, keyVersion: 1, requestingDeviceId: b.deviceId } });
    expect(evs[1].data).not.toHaveProperty('keyVersion');
    await expect(b.client.crypto.keys.request(id, b.deviceId, 0)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('participants', () => {
  it('add: needs a device in e2ee; idempotent; removal raises min_key_version once; repeat removal is NotFound', async () => {
    const w = makeWorld();
    const { a, b } = await pair(w);
    const c = await userWithDevice(w);
    const nodev = w.user();
    const { id } = await createConv(w, a, [b]);
    await expect(a.client.crypto.conversations.addParticipant(id, nodev.id)).rejects.toBeInstanceOf(ParticipantHasNoDeviceError);
    expect(await a.client.crypto.conversations.addParticipant(id, c.id)).toEqual({ conversationId: id, userId: c.id });
    await a.client.crypto.conversations.addParticipant(id, c.id); // idempotent
    expect(w.mock.state.conversation(id)!.participants).toEqual([a.id, b.id, c.id]);
    expect(w.mock.state.conversation(id)!.min_key_version).toBe(1); // adding never raises the floor
    expect(w.mock.eventsOf('participant.added')).toHaveLength(1);
    const r = await a.client.crypto.conversations.removeParticipant(id, c.id);
    expect(r).toEqual({ conversationId: id, userId: c.id, minKeyVersion: 2 });
    await expect(a.client.crypto.conversations.removeParticipant(id, c.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(w.mock.state.conversation(id)!.min_key_version).toBe(2);
    expect(w.mock.eventsOf('participant.removed')[0].data).toMatchObject({ userId: c.id, minKeyVersion: 2 });
    await expect(c.client.crypto.conversations.removeParticipant(id, b.id)).rejects.toBeInstanceOf(ForbiddenError); // no longer a member
    expect((await w.admin.crypto.conversations.removeParticipant(id, b.id)).minKeyVersion).toBe(2);
  });
  it('a plain conversation reports minKeyVersion null', async () => {
    const w = makeWorld();
    const a = w.user(), b = w.user();
    const conv = (await a.client.conversations.create({ type: 'direct', participantIds: [a.id, b.id] })) as unknown as { id: string; encryption_mode: string };
    expect(conv.encryption_mode).toBe('none');
    expect((await a.client.crypto.conversations.removeParticipant(conv.id, b.id)).minKeyVersion).toBeNull();
  });
});

describe('messages', () => {
  it('a real encrypted message round-trips through the mock', async () => {
    const w = makeWorld();
    const { a, b } = await pair(w);
    const { id, ck } = await createConv(w, a, [b]);
    const content = encryptSecureMessage({ text: 'hello' }, ck, { conversationId: id, keyVersion: 1, senderId: a.id });
    const msg = await a.client.crypto.messages.postEncrypted({ conversationId: id, senderId: a.id, content, keyVersion: 1 });
    const stored = w.mock.state.messages().find((m) => m.id === msg.id)!;
    expect(stored.metadata).toEqual({ scheme: 'ck-xchacha-v1', key_version: 1 });
    expect(decryptSecureMessage(stored.content as string, ck, { conversationId: id, keyVersion: 1, senderId: a.id }).text).toBe('hello');
  });
  it('server rules: plaintext, wrong scheme, short ciphertext, KEY_ROTATION_REQUIRED, above latest, opaque attachments', async () => {
    const w = makeWorld();
    const { a, b } = await pair(w);
    const { id, ck } = await createConv(w, a, [b]);
    const good = encryptSecureMessage({ text: 'x' }, ck, { conversationId: id, keyVersion: 1, senderId: a.id });
    const post = (over: Record<string, unknown>) => a.client.request('POST', '/api/v1/messages', { body: { conversationId: id, senderId: a.id, content: good, metadata: { scheme: 'ck-xchacha-v1', key_version: 1 }, ...over } });
    await expect(post({ content: 'hello world!' })).rejects.toMatchObject({ status: 400 });
    await expect(post({ content: 'plain text with spaces' })).rejects.toMatchObject({ status: 400 });
    await expect(post({ metadata: { key_version: 1 } })).rejects.toMatchObject({ status: 400 });
    await expect(post({ content: 'AAAA' })).rejects.toMatchObject({ status: 400 });
    await expect(post({ metadata: { scheme: 'ck-xchacha-v1', key_version: 2 } })).rejects.toMatchObject({ status: 400 });
    await expect(post({ attachments: [{ type: 'file', url: 'u', mimeType: 'image/png' }] })).rejects.toMatchObject({ status: 400 });
    await expect(post({ attachments: [{ type: 'file', url: 'u', mimeType: 'application/octet-stream' }] })).resolves.toBeDefined();
    await a.client.crypto.conversations.removeParticipant(id, b.id); // floor -> 2
    const err = await a.client.crypto.messages.postEncrypted({ conversationId: id, senderId: a.id, content: good, keyVersion: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(KeyRotationRequiredError);
    expect(err.minKeyVersion).toBe(2);
  });
  it('plain conversations reject metadata.scheme; plain messages are untouched', async () => {
    const w = makeWorld();
    const a = w.user(), b = w.user();
    const conv = (await a.client.conversations.create({ type: 'direct', participantIds: [a.id, b.id] })) as unknown as { id: string };
    await expect(a.client.crypto.messages.postEncrypted({ conversationId: conv.id, senderId: a.id, content: 'AAAA', keyVersion: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(a.client.messages.send({ conversationId: conv.id, senderId: a.id, content: 'hi' })).resolves.toBeDefined();
  });
});

describe('transport behaviour', () => {
  it('sends X-Device-Id on [Dev] routes and only there', async () => {
    const w = makeWorld();
    const { a, b } = await pair(w);
    const { id } = await createConv(w, a, [b]);
    w.mock.calls.length = 0;
    await a.client.crypto.keys.get(id, a.deviceId);
    await a.client.crypto.devices.list([a.id]);
    await a.client.crypto.backup.get().catch(() => {});
    expect(w.mock.calls.map((c) => [c.method, c.path.replace(id, ':id'), c.deviceId])).toEqual([
      ['GET', '/conversations/:id/keys', a.deviceId],
      ['GET', '/devices', null],
      ['GET', '/devices/backup', null],
    ]);
  });
  it('429 maps to RateLimitedError with retryAfter; GETs retry per the core client, POSTs never', async () => {
    const w = makeWorld();
    const u = w.user();
    w.mock.inject({ match: 'POST /devices', status: 429, code: 'RATE_LIMIT_EXCEEDED', retryAfter: 3, times: 5 });
    const e = await u.client.crypto.devices.register({ publicKey: newKeyPair().publicKeyB64 }).catch((x) => x);
    expect(e).toBeInstanceOf(RateLimitedError);
    expect(e.retryAfter).toBe(3);
    expect(w.mock.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
  it('a bad token is a plain ApiError 401, not an E2EE class', async () => {
    const w = makeWorld();
    const e = await w.clientFor('garbage').crypto.devices.list([uuid()]).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(401);
  });
  it('network failure surfaces as ApiError with status 0', async () => {
    const w = makeWorld();
    const { createClient } = await import('@messaging-express/client');
    const c = withCrypto(createClient({ baseUrl: 'http://mock', token: 'user:x', fetch: (async () => { throw new Error('offline'); }) as typeof fetch, maxRetries: 0 }), { keyStore: memoryKeyStore() });
    const e = await c.crypto.devices.list([uuid()]).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    void w;
  });
});
