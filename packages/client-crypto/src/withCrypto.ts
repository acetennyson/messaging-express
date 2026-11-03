import type { CryptoKeyStore } from './keystore/types';
import type { CryptoProvider } from './crypto/provider';
import { nobleProvider } from './crypto/noble';
import type { RequestClient } from './api/transport';
import * as devices from './api/devices';
import * as backup from './api/backup';
import * as keys from './api/keys';
import * as conversations from './api/conversations';
import { createDeviceManager, type DeviceManager } from './device/manager';
import { createSecureMessaging, type SecureMessaging, type Uploader, type Downloader } from './messaging/secure';

export interface WithCryptoOptions {
  keyStore: CryptoKeyStore;
  /** Defaults to the noble provider. */
  provider?: CryptoProvider;
  /** The signed-in user's id. Enables `crypto.device` (register, link, revoke with local state). */
  userId?: string;
  /** Upload of encrypted attachments. Default: `client.uploads.uploadOne(blob, { category: 'e2ee' })`. */
  uploader?: Uploader;
  /** Download of encrypted attachments. Default: `fetch(url)`. */
  download?: Downloader;
  /** Clock for the once-a-minute key-request throttle (tests). */
  now?: () => number;
}

/** Every Stage 7 route, bound to one client. Methods that need the calling device take its id explicitly (C5 adds the stateful layer). */
export function createCryptoApi(client: RequestClient) {
  return {
    devices: {
      register: (i: Parameters<typeof devices.registerDevice>[1], s?: AbortSignal) => devices.registerDevice(client, i, s),
      list: (userIds: string[], s?: AbortSignal) => devices.listDevices(client, userIds, s),
      revoke: (id: string, s?: AbortSignal) => devices.revokeDevice(client, id, s),
      pair: (deviceId: string, publicKey: string, s?: AbortSignal) => devices.pairDevice(client, deviceId, publicKey, s),
      link: (i: Parameters<typeof devices.linkDevice>[1], s?: AbortSignal) => devices.linkDevice(client, i, s),
      resetUser: (userId: string, s?: AbortSignal) => devices.resetUserDevices(client, userId, s),
    },
    backup: {
      put: (i: Parameters<typeof backup.putBackup>[1], s?: AbortSignal) => backup.putBackup(client, i, s),
      get: (s?: AbortSignal) => backup.getBackup(client, s),
      delete: (s?: AbortSignal) => backup.deleteBackup(client, s),
    },
    keys: {
      get: (conversationId: string, deviceId: string, s?: AbortSignal) => keys.getKeys(client, conversationId, deviceId, s),
      upload: (conversationId: string, deviceId: string, i: Parameters<typeof keys.uploadKeys>[3], s?: AbortSignal) => keys.uploadKeys(client, conversationId, deviceId, i, s),
      request: (conversationId: string, deviceId: string, keyVersion?: number, s?: AbortSignal) => keys.requestKeys(client, conversationId, deviceId, keyVersion, s),
    },
    conversations: {
      createEncrypted: (deviceId: string, i: conversations.CreateEncryptedConversationInput, s?: AbortSignal) => conversations.createEncryptedConversation(client, deviceId, i, s),
      addParticipant: (id: string, userId: string, s?: AbortSignal) => conversations.addParticipant(client, id, userId, s),
      removeParticipant: (id: string, userId: string, s?: AbortSignal) => conversations.removeParticipant(client, id, userId, s),
    },
    messages: {
      postEncrypted: (i: conversations.PostMessageInput, s?: AbortSignal) => conversations.postEncryptedMessage(client, i, s),
    },
  };
}

export type CryptoApi = ReturnType<typeof createCryptoApi>;
export interface CryptoNamespace extends CryptoApi {
  readonly keyStore: CryptoKeyStore;
  readonly provider: CryptoProvider;
  /** Present when `userId` was given to withCrypto. */
  readonly device?: DeviceManager;
  /** Create, send, decrypt, open attachments. Present when `userId` was given. */
  readonly secure?: SecureMessaging;
}

/** `client` plus a `.crypto` namespace. The client's own methods are untouched and still work without it. */
export function withCrypto<C extends RequestClient>(client: C, options: WithCryptoOptions): C & { crypto: CryptoNamespace } {
  if (!options || !options.keyStore) throw new TypeError('withCrypto: "keyStore" is required');
  const provider = options.provider ?? nobleProvider;
  const device = options.userId ? createDeviceManager({ client, keyStore: options.keyStore, userId: options.userId, provider }) : undefined;
  const secure = device && options.userId
    ? createSecureMessaging({ client: client as never, device, keyStore: options.keyStore, userId: options.userId, provider, uploader: options.uploader, download: options.download, now: options.now })
    : undefined;
  const crypto: CryptoNamespace = Object.freeze({ ...createCryptoApi(client), keyStore: options.keyStore, provider, device, secure });
  return Object.assign(Object.create(Object.getPrototypeOf(client)), client, { crypto });
}
