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
