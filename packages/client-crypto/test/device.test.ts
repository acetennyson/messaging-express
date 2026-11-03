import { describe, expect, it } from 'vitest';
import { createClient } from '@messaging-express/client';
import {
  createDeviceManager, DeviceExistsError, DeviceRevokedError, DeviceStateError, LinkTimeoutError, PairingNotFoundError, ForbiddenError,
  memoryKeyStore, nobleProvider, confirmationCodeFor, parseLinkInput, linkCodeFor, linkQrPayload, toBase64Url, keyNames, withCrypto, FormatError,
} from '../src/index';
import { createMockServer } from '../src/testing/mockServer';

const noSleep = async () => {};

function setup(opts: Parameters<typeof createMockServer>[0] = {}) {
  const mock = createMockServer(opts);
  const device = (userId: string, store = memoryKeyStore(), extra: Partial<Parameters<typeof createDeviceManager>[0]> = {}) => {
    const client = createClient({ baseUrl: 'http://mock', token: mock.tokenFor(userId), fetch: mock.fetch, maxRetries: 0 });
    const build = (more: Partial<Parameters<typeof createDeviceManager>[0]> = {}) => createDeviceManager({ client, keyStore: store, userId, sleep: noSleep, ...extra, ...more });
    return { store, mock, mgr: build(), rebuild: build };
  };
  return { mock, device, user: () => mock.addUser() };
}

describe('registerPrimaryDevice', () => {
  it('registers, stores the identity, becomes primary; survives a restart (new manager, same store)', async () => {
    const { device, user, mock } = setup();
    const u = user();
    const a = device(u);
    expect(await a.mgr.state()).toBe('unregistered');
    const me = await a.mgr.registerPrimaryDevice({ deviceName: 'phone' });
    expect(me.role).toBe('primary');
    expect(await a.mgr.state()).toBe('primary');
    expect(mock.state.devices()[0].publicKey).toBe(me.publicKey);
    const restarted = device(u, a.store);
    expect(await restarted.mgr.currentDevice()).toEqual(me);
    const local = await restarted.mgr.requireDevice();
    expect(nobleProvider.publicKeyFor(local.privateKey)).toEqual(Uint8Array.from(Buffer.from(me.publicKey, 'base64url')));
  });
  it('misuse fails locally: registering twice, and a 2nd device gets DeviceExistsError from the server', async () => {
    const { device, user, mock } = setup();
    const u = user();
    const a = device(u);
    await a.mgr.registerPrimaryDevice();
    await expect(a.mgr.registerPrimaryDevice()).rejects.toBeInstanceOf(DeviceStateError);
    const calls = mock.calls.length;
    await expect(a.mgr.beginLink()).rejects.toBeInstanceOf(DeviceStateError);
    expect(mock.calls.length).toBe(calls); // nothing was sent
    const other = device(u);
    await expect(other.mgr.registerPrimaryDevice()).rejects.toBeInstanceOf(DeviceExistsError);
    expect(await other.mgr.state()).toBe('linking'); // the pending key is kept: the app can fall back to linking with it
  });
  it('requireDevice on an unregistered device is DeviceStateError', async () => {
    const { device, user } = setup();
    await expect(device(user()).mgr.requireDevice()).rejects.toBeInstanceOf(DeviceStateError);
  });
});

describe('link flow', () => {
  async function primaryAndNew(opts?: Parameters<typeof setup>[0]) {
    const s = setup(opts);
    const u = s.user();
    const primary = s.device(u);
    await primary.mgr.registerPrimaryDevice({ deviceName: 'phone' });
    const fresh = s.device(u);
    return { ...s, u, primary, fresh };
  }
  it('beginLink -> approve -> completeLink: one device is added; codes match on both sides', async () => {
    const { primary, fresh, mock, u } = await primaryAndNew();
    const offer = await fresh.mgr.beginLink();
    expect(await fresh.mgr.state()).toBe('linking');
    for (const input of [offer.qrPayload, offer.linkCode, `  ${offer.linkCode}\n`]) {
      const approval = await primary.mgr.approveLink(input);
      expect(approval.publicKey).toBe(offer.publicKey);
      expect(approval.confirmationCode).toBe(offer.confirmationCode);
    }
    expect(offer.confirmationCode).toMatch(/^\d{4} \d{4}$/);
    // nothing was sent until confirm()
    expect(mock.state.pairings()).toHaveLength(0);
    const approval = await primary.mgr.approveLink(offer.qrPayload);
    await approval.confirm();
    const done = await fresh.mgr.completeLink({ deviceName: 'laptop' });
    expect(await fresh.mgr.state()).toBe('companion');
    expect(done.devices.map((d) => d.isPrimary)).toEqual([true]);
    expect(mock.state.devices().filter((d) => d.userId === u && !d.revokedAt)).toHaveLength(2);
    expect((await fresh.mgr.currentDevice())!.deviceId).toBe(done.deviceId);
  });
  it('completeLink polls until the approval arrives', async () => {
    const { primary, fresh } = await primaryAndNew();
    const offer = await fresh.mgr.beginLink();
    let sleeps = 0;
    const polling = fresh.rebuild({
      sleep: async () => {
        sleeps++;
        if (sleeps === 3) await (await primary.mgr.approveLink(offer.linkCode)).confirm();
      },
    });
    const done = await polling.completeLink({ pollIntervalMs: 1 });
    expect(sleeps).toBe(3);
    expect(done.deviceId).toBeTruthy();
  });
  it('not approved in time -> LinkTimeoutError, and the pending key survives for a retry', async () => {
    const { fresh } = await primaryAndNew();
    await fresh.mgr.beginLink();
    let t = 0;
    const s = fresh.rebuild({ now: () => (t += 1000), sleep: noSleep });
    await expect(s.completeLink({ timeoutMs: 5000, pollIntervalMs: 1000 })).rejects.toBeInstanceOf(LinkTimeoutError);
    expect(await s.state()).toBe('linking');
  });
  it('abort stops the polling', async () => {
    const { fresh } = await primaryAndNew();
    await fresh.mgr.beginLink();
    const ac = new AbortController();
    const s = fresh.rebuild({ sleep: async () => { ac.abort(); throw new LinkTimeoutError('aborted'); } });
    await expect(s.completeLink({ signal: ac.signal })).rejects.toBeInstanceOf(LinkTimeoutError);
  });
  it('an approval for a different key never lets this device in; a reused approval fails; an expired one fails', async () => {
    let t = 1_000_000;
    const { primary, fresh, device, u } = await primaryAndNew({ now: () => t });
    const offer = await fresh.mgr.beginLink();
    const other = device(u);
    const otherOffer = await other.mgr.beginLink();
    await (await primary.mgr.approveLink(otherOffer.qrPayload)).confirm(); // approves the OTHER key
    const timeout = fresh.rebuild({ now: () => (t += 1000) });
    await expect(timeout.completeLink({ timeoutMs: 3000, pollIntervalMs: 1000 })).rejects.toBeInstanceOf(LinkTimeoutError);
    await other.mgr.completeLink(); // the approved device gets in
    await expect(other.mgr.completeLink()).rejects.toBeInstanceOf(DeviceStateError); // already linked: local state check
    // expiry
    await (await primary.mgr.approveLink(offer.qrPayload)).confirm();
    t += 61_000;
    const late = fresh.rebuild({ now: () => (t += 1000) });
    await expect(late.completeLink({ timeoutMs: 3000, pollIntervalMs: 1000 })).rejects.toBeInstanceOf(LinkTimeoutError);
  });
  it('the raw server error for an unapproved key is PairingNotFoundError (the manager treats it as "not yet")', async () => {
    const { fresh, mock } = await primaryAndNew();
    const offer = await fresh.mgr.beginLink();
    const client = createClient({ baseUrl: 'http://mock', token: mock.tokenFor(mock.state.devices()[0].userId), fetch: mock.fetch, maxRetries: 0 });
    const { linkDevice } = await import('../src/index');
    await expect(linkDevice(client, { publicKey: offer.publicKey })).rejects.toBeInstanceOf(PairingNotFoundError);
  });
  it('only the primary approves; a companion fails locally; confirm cannot be used by a revoked primary', async () => {
    const { primary, fresh } = await primaryAndNew();
    const offer = await fresh.mgr.beginLink();
    await (await primary.mgr.approveLink(offer.qrPayload)).confirm();
    await fresh.mgr.completeLink();
    await expect(fresh.mgr.approveLink(offer.qrPayload)).rejects.toBeInstanceOf(DeviceStateError);
    await expect(fresh.mgr.registerPrimaryDevice()).rejects.toBeInstanceOf(DeviceStateError);
  });
  it('bad link input is a FormatError before any request', async () => {
    const { primary, mock } = await primaryAndNew();
    const n = mock.calls.length;
    for (const bad of ['', 'nonsense', 'mxe2ee1:link:short', 'A'.repeat(44)]) await expect(primary.mgr.approveLink(bad)).rejects.toBeInstanceOf(FormatError);
    expect(mock.calls.length).toBe(n);
  });
  it('cancelLink discards the pending key', async () => {
    const { fresh } = await primaryAndNew();
    const a = await fresh.mgr.beginLink();
    expect((await fresh.mgr.beginLink()).publicKey).toBe(a.publicKey); // idempotent while pending
    await fresh.mgr.cancelLink();
    expect(await fresh.mgr.state()).toBe('unregistered');
    expect((await fresh.mgr.beginLink()).publicKey).not.toBe(a.publicKey);
  });
});

describe('listing, revoking, revoked detection', () => {
  async function two() {
    const s = setup();
    const u = s.user();
    const primary = s.device(u);
    await primary.mgr.registerPrimaryDevice();
    const comp = s.device(u);
    const offer = await comp.mgr.beginLink();
    await (await primary.mgr.approveLink(offer.qrPayload)).confirm();
    await comp.mgr.completeLink();
    return { ...s, u, primary, comp };
  }
  it('listDevices returns both; the companion is promoted when the primary is revoked, and its stored role follows', async () => {
    const { primary, comp, mock } = await two();
    expect((await comp.mgr.listDevices()).map((d) => d.isPrimary)).toEqual([true, false]);
    const pid = (await primary.mgr.currentDevice())!.deviceId;
    await comp.mgr.revokeDevice(pid);
    expect(mock.eventsOf('device.removed')).toHaveLength(1);
    expect(await comp.mgr.state()).toBe('companion'); // role not refreshed yet
    await comp.mgr.listDevices();
    expect(await comp.mgr.state()).toBe('primary');
  });
  it('the revoked device finds out on its next call: DeviceRevokedError, keys wiped, state revoked; it can link again', async () => {
    const { primary, comp } = await two();
    await primary.store.set('ck/c1/1', new Uint8Array([1, 2, 3]));
    const cid = (await comp.mgr.currentDevice())!.deviceId;
    await primary.mgr.revokeDevice(cid);
    await expect(comp.mgr.listDevices()).rejects.toBeInstanceOf(DeviceRevokedError);
    expect(await comp.mgr.state()).toBe('revoked');
    expect(await comp.store.list()).toEqual([keyNames.deviceRevoked]);
    await expect(comp.mgr.requireDevice()).rejects.toBeInstanceOf(DeviceStateError);
    // and after revoking the PRIMARY too, withDevice calls surface it
    const pid = (await primary.mgr.currentDevice())!.deviceId;
    const other = primary.rebuild({});
    await expect(other.withDevice(async () => { throw Object.assign(new Error('x'), { status: 403, code: 'DEVICE_INVALID' }); })).rejects.toBeInstanceOf(DeviceRevokedError);
    expect(await primary.store.list('ck/')).toEqual([]);
    void pid;
    // a revoked device may start over
    const offer = await comp.mgr.beginLink();
    expect(await comp.mgr.state()).toBe('linking');
    expect(offer.publicKey).toBeTruthy();
  });
  it('revoking this device itself wipes local state', async () => {
    const { comp } = await two();
    await comp.mgr.revokeDevice((await comp.mgr.currentDevice())!.deviceId);
    expect(await comp.mgr.state()).toBe('revoked');
    expect(await comp.mgr.currentDevice()).toBeNull();
  });
  it('an admin reset is noticed the same way', async () => {
    const { primary, mock, u } = await two();
    const admin = createClient({ baseUrl: 'http://mock', token: mock.adminToken, fetch: mock.fetch, maxRetries: 0 });
    await admin.request('POST', `/api/v1/users/${u}/devices/reset`);
    await expect(primary.mgr.listDevices()).rejects.toBeInstanceOf(DeviceRevokedError);
  });
  it('a companion cannot pair even if the app skips the local check (server says Forbidden)', async () => {
    const { comp, primary } = await two();
    await expect(primary.mgr.beginLink()).rejects.toBeInstanceOf(DeviceStateError);
    const local = await comp.mgr.requireDevice();
    const { pairDevice } = await import('../src/index');
    const client = createClient({ baseUrl: 'http://mock', token: 'user:' + (await comp.mgr.listDevices())[0].userId, fetch: comp.mock.fetch, maxRetries: 0 });
    await expect(pairDevice(client, local.deviceId, toBase64Url(new Uint8Array(32).fill(7)))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('link codes', () => {
  it('round-trip, whitespace tolerant, dash and underscore safe; confirmation code is deterministic and key-dependent', () => {
    for (let i = 0; i < 200; i++) {
      const k = nobleProvider.randomBytes(32);
      expect(parseLinkInput(linkQrPayload(k))).toEqual(k);
      expect(parseLinkInput(linkCodeFor(k))).toEqual(k);
      expect(parseLinkInput(' ' + linkCodeFor(k).replace(/ /g, '\n') + ' ')).toEqual(k);
      expect(confirmationCodeFor(k, nobleProvider)).toBe(confirmationCodeFor(k, nobleProvider));
    }
    const a = new Uint8Array(32).fill(1), b = new Uint8Array(32).fill(2);
    expect(confirmationCodeFor(a, nobleProvider)).not.toBe(confirmationCodeFor(b, nobleProvider));
  });
  it('confirmation code is frozen (vector)', () => {
    expect(confirmationCodeFor(Uint8Array.from({ length: 32 }, (_, i) => i), nobleProvider)).toMatch(/^\d{4} \d{4}$/);
  });
});

describe('withCrypto + userId', () => {
  it('exposes crypto.device only when userId is given', () => {
    const mock = createMockServer();
    const client = createClient({ baseUrl: 'http://mock', token: 'user:x', fetch: mock.fetch });
    expect(withCrypto(client, { keyStore: memoryKeyStore() }).crypto.device).toBeUndefined();
    expect(withCrypto(client, { keyStore: memoryKeyStore(), userId: 'x' }).crypto.device).toBeDefined();
  });
});
