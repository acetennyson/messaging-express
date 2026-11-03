import type { CryptoKeyStore } from './keystore/types';
import type { CryptoProvider } from './crypto/provider';
import { nobleProvider } from './crypto/noble';
import type { RequestClient } from './api/transport';
import * as devices from './api/devices';
import * as backup from './api/backup';
import * as keys from './api/keys';
import * as conversations from './api/conversations';
import { createDeviceManager, type DeviceManager } from './device/manager';
import { createSafetyManager, type SafetyManager } from './safety/manager';
import { createBackupManager, type BackupManager } from './backup/manager';
import { createRekeyEngine, type RekeyEngine, type EventSource, type DeviceTrust, type LinkedDeviceHistory } from './rekey/engine';
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
  /** Realtime events (the core `createRealtime(...)` client fits). When given, the re-keying engine starts listening: new devices get keys, removals rotate the key. */
  events?: EventSource;
  /** "auto" (default) or "confirm": whether other users' new devices wait for `crypto.rekey.approveDevice(id)`. */
  deviceTrust?: DeviceTrust;
  /** What a newly linked device can read: "all" (default), "latest" or "none". */
  linkedDeviceHistory?: LinkedDeviceHistory;
  /** Random delay before acting on an event, in ms. Default 2000. */
  jitterMs?: number;
  /** Backup settings: Argon2id cost for new backups, shortest passphrase, restore cost limit. */
  backup?: { params?: { m: number; t: number; p: number }; minPassphraseLength?: number; maxParams?: { m: number; t: number; p: number } };
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
type BackupApi = CryptoApi['backup'];
export interface CryptoNamespace extends Omit<CryptoApi, 'backup'> {
  /** put/get/delete are the raw routes; with `userId` it is also create/restore/status/generateRecoveryCode (see createBackupManager). */
  readonly backup: CryptoApi['backup'] & Partial<BackupManager>;
  readonly keyStore: CryptoKeyStore;
  readonly provider: CryptoProvider;
  /** Present when `userId` was given to withCrypto. */
  readonly device?: DeviceManager;
  /** Create, send, decrypt, open attachments. Present when `userId` was given. */
  readonly secure?: SecureMessaging;
  /** Re-keying engine: device changes, rotation, approval. Present when `userId` was given; listens to `events` if provided. */
  readonly rekey?: RekeyEngine;
  /** Safety numbers (compare with another user to detect a device you should not trust). Present when `userId` was given. */
  readonly safety?: SafetyManager;
}

/** `client` plus a `.crypto` namespace. The client's own methods are untouched and still work without it. */
export function withCrypto<C extends RequestClient>(client: C, options: WithCryptoOptions): C & { crypto: CryptoNamespace } {
  if (!options || !options.keyStore) throw new TypeError('withCrypto: "keyStore" is required');
  const provider = options.provider ?? nobleProvider;
  const device = options.userId ? createDeviceManager({ client, keyStore: options.keyStore, userId: options.userId, provider }) : undefined;
  const secure = device && options.userId
    ? createSecureMessaging({ client: client as never, device, keyStore: options.keyStore, userId: options.userId, provider, uploader: options.uploader, download: options.download, now: options.now })
    : undefined;
  const rekey = device && secure && options.userId
    ? createRekeyEngine({ client, device, secure, keyStore: options.keyStore, userId: options.userId, provider, deviceTrust: options.deviceTrust, linkedDeviceHistory: options.linkedDeviceHistory, jitterMs: options.jitterMs, now: options.now })
    : undefined;
  if (rekey && options.events) rekey.start(options.events);
  const api = createCryptoApi(client);
  const backupMgr = device && options.userId ? createBackupManager({ client, device, secure, userId: options.userId, provider, ...options.backup }) : undefined;
  // raw put/get stay available; with a userId, create/restore/status/generateRecoveryCode are added and delete is the raw route (idempotent)
  const backup = backupMgr ? Object.freeze({ ...api.backup, ...backupMgr }) : api.backup;
  const safety = options.userId ? createSafetyManager({ client, keyStore: options.keyStore, userId: options.userId, provider }) : undefined;
  const crypto: CryptoNamespace = Object.freeze({ ...api, backup, keyStore: options.keyStore, provider, device, secure, rekey, safety });
  return Object.assign(Object.create(Object.getPrototypeOf(client)), client, { crypto });
}
