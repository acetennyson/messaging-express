import { createClient } from '@messaging-express/client';
import { createMockServer, type MockOptions } from '../src/testing/mockServer';
import { nobleProvider } from '../src/crypto/noble';
import { toBase64Url } from '../src/format/base64url';
import { memoryKeyStore } from '../src/keystore/memory';
import { withCrypto } from '../src/withCrypto';

export function newKeyPair() {
  const kp = nobleProvider.generateKeyPair();
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, publicKeyB64: toBase64Url(kp.publicKey) };
}

export function makeWorld(opts: MockOptions = {}) {
  const mock = createMockServer(opts);
  const clientFor = (token: string) => withCrypto(createClient({ baseUrl: 'http://mock', token, fetch: mock.fetch, maxRetries: 0 }), { keyStore: memoryKeyStore() });
  const user = () => {
    const id = mock.addUser();
    return { id, client: clientFor(mock.tokenFor(id)) };
  };
  return { mock, clientFor, user, admin: clientFor(mock.adminToken), api: clientFor(mock.apiToken) };
}
export type World = ReturnType<typeof makeWorld>;

/** A user with a registered primary device. */
export async function userWithDevice(w: World, name = 'phone') {
  const u = w.user();
  const kp = newKeyPair();
  const dev = await u.client.crypto.devices.register({ publicKey: kp.publicKeyB64, deviceName: name });
  return { ...u, kp, deviceId: dev.id };
}

import { createClient as _cc } from '@messaging-express/client';
/** A user with withCrypto fully wired (device manager, secure messaging, mock uploader/downloader) and a registered primary device. */
export async function secureUser(w: World, opts: { now?: () => number; fetch?: typeof fetch; register?: boolean; live?: boolean; deviceTrust?: 'auto' | 'confirm'; linkedDeviceHistory?: 'all' | 'latest' | 'none'; jitterMs?: number } = {}) {
  const id = w.mock.addUser();
  const store = memoryKeyStore();
  const client = withCrypto(_cc({ baseUrl: 'http://mock', token: w.mock.tokenFor(id), fetch: opts.fetch ?? w.mock.fetch, maxRetries: 0 }), {
    keyStore: store, userId: id, uploader: w.mock.uploaderFor(id), download: w.mock.download, now: opts.now,
    events: opts.live ? w.mock.subscribe(id) : undefined, deviceTrust: opts.deviceTrust, linkedDeviceHistory: opts.linkedDeviceHistory, jitterMs: opts.jitterMs ?? 0,
  });
  if (opts.register !== false) await client.crypto.device!.registerPrimaryDevice({ deviceName: 'phone' });
  return { id, store, client, dev: client.crypto.device!, sec: client.crypto.secure!, rekey: client.crypto.rekey! };
}
export type SecureUser = Awaited<ReturnType<typeof secureUser>>;
/** Fetch the stored messages of a conversation as the server returns them, as this user. */
export async function stored(u: SecureUser, conversationId: string) {
  return (await u.client.messages.list({ conversationId })).data as unknown as import('../src/index').ServerMessage[];
}
/** Link a second device for the user (approved by the primary), returning a manager for it. */
export async function linkSecondDevice(w: World, u: SecureUser, o: { live?: boolean } = {}) {
  const store = memoryKeyStore();
  const c = withCrypto(_cc({ baseUrl: 'http://mock', token: w.mock.tokenFor(u.id), fetch: w.mock.fetch, maxRetries: 0 }), { keyStore: store, userId: u.id, uploader: w.mock.uploaderFor(u.id), download: w.mock.download, events: o.live ? w.mock.subscribe(u.id) : undefined, jitterMs: 0 });
  const d = c.crypto.device!;
  const offer = await d.beginLink();
  await (await u.dev.approveLink(offer.qrPayload)).confirm();
  await d.completeLink({ deviceName: 'laptop' });
  return { store, client: c, dev: d, sec: c.crypto.secure!, rekey: c.crypto.rekey! };
}
