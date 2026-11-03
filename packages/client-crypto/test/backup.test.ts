import { describe, expect, it } from 'vitest';
import {
  generateRecoveryCode, classifySecret, WeakSecretError, InvalidRecoveryCodeError, NoBackupError, BackupCostTooHighError, BackupDeviceGoneError,
  DecryptError, DeviceStateError, nobleProvider, BACKUP_PARAMS,
} from '../src/index';
import { makeWorld, secureUser, blankDeviceFor, linkSecondDevice, stored, FAST, type World, type SecureUser } from './world';

const CODE = /^([0-9A-HJKMNP-TV-Z]{4}-){8}[0-9A-HJKMNP-TV-Z]{4}$/;
async function aliceBob(w: World) {
  const alice = await secureUser(w), bob = await secureUser(w);
  const conv = await alice.sec.createSecureConversation({ participantIds: [bob.id] });
  await alice.sec.sendSecureMessage({ conversationId: conv.id, text: 'old news' });
  return { alice, bob, id: conv.id };
}
const texts = async (u: { sec: SecureUser['sec']; client: SecureUser['client'] }, id: string) =>
  (await u.sec.decryptMessages((await u.client.messages.list({ conversationId: id })).data as never)).map((o) => (o.ok ? o.message.text : 'ERR'));

describe('recovery codes', () => {
  it('are 160 random bits in 9 groups of 4, all different', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) { const c = generateRecoveryCode(); expect(c).toMatch(CODE); seen.add(c); }
    expect(seen.size).toBe(50);
  });
  it('forgive case, spaces, dashes and look-alike letters, and reduce to the same secret', () => {
    const c = generateRecoveryCode();
    const base = classifySecret(c);
    expect(base.kind).toBe('recovery-code');
    expect(base.secret).toHaveLength(32);
    expect(classifySecret(c.toLowerCase().replace(/-/g, ' ')).secret).toBe(base.secret);
    expect(classifySecret(c.replace(/0/g, 'o').replace(/1/g, 'l')).secret).toBe(base.secret);
  });
  it('a typo in any of the 36 positions is caught before any slow work', () => {
    const c = generateRecoveryCode().replace(/-/g, '');
    for (let i = 0; i < c.length; i++) {
      const other = c[i] === '2' ? '3' : '2';
      expect(() => classifySecret(c.slice(0, i) + other + c.slice(i + 1)), `position ${i}`).toThrow(InvalidRecoveryCodeError);
    }
  });
  it('anything else is a passphrase, used as typed', () => {
    expect(classifySecret('correct horse battery staple')).toEqual({ kind: 'passphrase', secret: 'correct horse battery staple' });
  });
});

describe('create', () => {
  it('rejects a short passphrase, accepts a code or a long passphrase, and the minimum is configurable', async () => {
    const w = makeWorld();
    const a = await secureUser(w);
    await expect(a.client.crypto.backup.create!('hunter2')).rejects.toBeInstanceOf(WeakSecretError);
    expect(w.mock.calls.some((c) => c.path === '/devices/backup')).toBe(false);
    expect((await a.client.crypto.backup.create!(generateRecoveryCode())).kind).toBe('recovery-code');
    expect((await a.client.crypto.backup.create!('a long enough passphrase')).kind).toBe('passphrase');
    const b = await secureUser(w, { backup: { ...FAST, minPassphraseLength: 4 } });
    await expect(b.client.crypto.backup.create!('abcd')).resolves.toBeTruthy();
  });
  it('stores only an opaque blob and the KDF header: neither the secret nor the key is in any request', async () => {
    const w = makeWorld();
    const a = await secureUser(w);
    const pass = 'correct horse battery staple';
    await a.client.crypto.backup.create!(pass);
    const priv = (await a.dev.requireDevice()).privateKey;
    const b64 = Buffer.from(priv).toString('base64url');
    const put = w.mock.calls.filter((c) => c.method === 'PUT' && c.path === '/devices/backup');
    expect(put).toHaveLength(1);
    const dump = JSON.stringify(w.mock.state.backup?.(a.id) ?? {});
    expect(dump.includes(pass)).toBe(false); expect(dump.includes(b64)).toBe(false);
  });
  it('uses 64 MiB / 3 passes by default and reports progress', async () => {
    expect(BACKUP_PARAMS).toEqual({ m: 65536, t: 3, p: 1 });
    const w = makeWorld();
    const a = await secureUser(w);
    const seen: number[] = [];
    const r = await a.client.crypto.backup.create!(generateRecoveryCode(), { onProgress: (f) => seen.push(f) });
    expect(r.params).toEqual(FAST.params);
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
  });
  it('replaces the previous backup, and status tells you', async () => {
    const w = makeWorld();
    const a = await secureUser(w);
    expect(await a.client.crypto.backup.status!()).toEqual({ exists: false });
    await a.client.crypto.backup.create!(generateRecoveryCode());
    const st = await a.client.crypto.backup.status!();
    expect(st).toMatchObject({ exists: true, params: FAST.params });
    await a.client.crypto.backup.delete();
    expect(await a.client.crypto.backup.status!()).toEqual({ exists: false });
    await expect(a.client.crypto.backup.delete()).resolves.toEqual({ deleted: true }); // idempotent, like the server
  });
});

describe('restore', () => {
  it('a brand-new phone gets the same identity back and can read the old history and keep talking', async () => {
    const w = makeWorld();
    const { alice, bob, id } = await aliceBob(w);
    const code = generateRecoveryCode();
    await alice.client.crypto.backup.create!(code);
    const phone2 = blankDeviceFor(w, alice.id);
    const progress: number[] = [];
    const r = await phone2.client.crypto.backup.restore!(code.toLowerCase(), { onProgress: (f) => progress.push(f) });
    const orig = await alice.dev.currentDevice();
    expect(r).toMatchObject({ deviceId: orig!.deviceId, role: 'primary', conversations: { total: 1, withKeys: 1, failed: [] } });
    expect(progress.length).toBeGreaterThan(0);
    expect(await phone2.dev.state()).toBe('primary');
    expect(await texts(phone2, id)).toEqual(['old news']);
    await phone2.sec.sendSecureMessage({ conversationId: id, text: 'back again' });
    expect((await texts(bob, id)).sort()).toEqual(['back again', 'old news']);
    expect(w.mock.state.devices().filter((d) => d.userId === alice.id && !d.revokedAt)).toHaveLength(1); // no new device was created
  });
  it('restores a companion device as a companion', async () => {
    const w = makeWorld();
    const { alice, id } = await aliceBob(w);
    const laptop = await linkSecondDevice(w, alice);
    await laptop.sec.refreshKeys(id).catch(() => undefined);
    const lt = Object.assign(laptop, { client: laptop.client });
    await lt.client.crypto.backup.create!('a long enough passphrase', { params: FAST.params });
    const fresh = blankDeviceFor(w, alice.id);
    const r = await fresh.client.crypto.backup.restore!('a long enough passphrase');
    expect(r.role).toBe('companion');
    expect(r.deviceId).toBe((await lt.dev.currentDevice())!.deviceId);
  });
  it('a wrong secret and a wrong code both fail as DecryptError, and nothing is adopted', async () => {
    const w = makeWorld();
    const { alice } = await aliceBob(w);
    const code = generateRecoveryCode();
    await alice.client.crypto.backup.create!(code);
    const p = blankDeviceFor(w, alice.id);
    await expect(p.client.crypto.backup.restore!('some other long passphrase')).rejects.toBeInstanceOf(DecryptError);
    await expect(p.client.crypto.backup.restore!(generateRecoveryCode())).rejects.toBeInstanceOf(DecryptError);
    await expect(p.client.crypto.backup.restore!(code.slice(0, -1) + (code.endsWith('2') ? '3' : '2'))).rejects.toBeInstanceOf(InvalidRecoveryCodeError);
    expect(await p.dev.state()).toBe('unregistered');
    expect(await p.store.list()).toEqual([]);
  });
  it('no backup -> NoBackupError; a device that already has an identity is not overwritten', async () => {
    const w = makeWorld();
    const { alice } = await aliceBob(w);
    await expect(blankDeviceFor(w, alice.id).client.crypto.backup.restore!(generateRecoveryCode())).rejects.toBeInstanceOf(NoBackupError);
    const code = generateRecoveryCode();
    await alice.client.crypto.backup.create!(code);
    const gets = () => w.mock.calls.filter((c) => c.method === 'GET' && c.path === '/devices/backup').length, before = gets();
    await expect(alice.client.crypto.backup.restore!(code)).rejects.toBeInstanceOf(DeviceStateError);
    expect(gets()).toBe(before); // refused before any download or derivation
  });
  it('a backup whose device has been revoked since is refused, and the phone stays blank', async () => {
    const w = makeWorld();
    const { alice } = await aliceBob(w);
    const code = generateRecoveryCode();
    await alice.client.crypto.backup.create!(code);
    await w.admin.crypto.devices.resetUser(alice.id);
    const p = blankDeviceFor(w, alice.id);
    const e = await p.client.crypto.backup.restore!(code).catch((x) => x);
    expect(e).toBeInstanceOf(BackupDeviceGoneError);
    expect(await p.dev.state()).toBe('unregistered');
  });
  it('a server that lists a different key for that device is refused', async () => {
    const w = makeWorld();
    const { alice } = await aliceBob(w);
    const code = generateRecoveryCode();
    await alice.client.crypto.backup.create!(code);
    const lying: typeof fetch = async (i, init) => {
      const r = await w.mock.fetch(i, init);
      if (!String(typeof i === 'string' ? i : (i as Request).url).includes('/devices?')) return r;
      const j = await r.json();
      for (const d of j.data) d.publicKey = Buffer.from(nobleProvider.generateKeyPair().publicKey).toString('base64url');
      return new Response(JSON.stringify(j), { status: r.status, headers: r.headers });
    };
    const p = blankDeviceFor(w, alice.id, { fetch: lying });
    const e = await p.client.crypto.backup.restore!(code).catch((x) => x);
    expect(e).toBeInstanceOf(BackupDeviceGoneError);
    expect(e.message).toMatch(/different key/);
    expect(await p.dev.state()).toBe('unregistered');
  });
  it('a malicious header asking for huge memory is refused before any derivation', async () => {
    const w = makeWorld();
    const { alice } = await aliceBob(w);
    const code = generateRecoveryCode();
    await alice.client.crypto.backup.create!(code);
    const good = await alice.client.crypto.backup.get();
    await alice.client.crypto.backup.put({ blob: good.blob, kdf: { ...good.kdf, m: 4_000_000 } });
    const t0 = Date.now();
    const e = await blankDeviceFor(w, alice.id).client.crypto.backup.restore!(code).catch((x) => x);
    expect(e).toBeInstanceOf(BackupCostTooHighError);
    expect(Date.now() - t0).toBeLessThan(1000);
    // and the limit is the caller's to raise
    await alice.client.crypto.backup.put({ blob: good.blob, kdf: { ...good.kdf, t: 9 } });
    expect(await blankDeviceFor(w, alice.id).client.crypto.backup.restore!(code).catch((x) => x)).toBeInstanceOf(BackupCostTooHighError);
  });
  it('a changed header (the server tampering with parameters or salt) fails authentication', async () => {
    const w = makeWorld();
    const { alice } = await aliceBob(w);
    const code = generateRecoveryCode();
    await alice.client.crypto.backup.create!(code);
    const good = await alice.client.crypto.backup.get();
    for (const kdf of [{ ...good.kdf, t: good.kdf.t + 1 }, { ...good.kdf, m: good.kdf.m * 2 }, { ...good.kdf, salt: Buffer.from(new Uint8Array(16)).toString('base64url') }]) {
      await alice.client.crypto.backup.put({ blob: good.blob, kdf });
      expect(await blankDeviceFor(w, alice.id).client.crypto.backup.restore!(code).catch((x) => x)).toBeInstanceOf(DecryptError);
    }
  });
  it('fetchKeys:false only restores the identity; a conversation with no key for this device is reported, not hidden', async () => {
    const w = makeWorld();
    const { alice, id } = await aliceBob(w);
    const carol = await secureUser(w);
    // Alice is added to a conversation without anyone sealing a key for her devices
    const other = await carol.sec.createSecureConversation({ participantIds: [alice.id] });
    w.mock.state.keys().filter((k) => k.conversationId === other.id && k.deviceId === (w.mock.state.devices().find((d) => d.userId === alice.id)!.id)).forEach((k) => w.mock.state.removeKey?.(k));
    const code = generateRecoveryCode();
    await alice.client.crypto.backup.create!(code);
    const a = blankDeviceFor(w, alice.id);
    const bare = await a.client.crypto.backup.restore!(code, { fetchKeys: false });
    expect(bare.conversations).toEqual({ total: 0, withKeys: 0, failed: [] });
    expect(await a.sec.heldVersions(id)).toEqual([]);
    const full = blankDeviceFor(w, alice.id);
    const r = await full.client.crypto.backup.restore!(code);
    expect(r.conversations.total).toBe(2);
    expect(r.conversations.withKeys).toBe(1);
    expect(r.conversations.failed.map((f) => f.conversationId)).toEqual([other.id]);
  });
});
