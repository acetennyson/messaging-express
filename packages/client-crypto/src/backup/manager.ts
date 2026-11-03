import type { CryptoProvider } from '../crypto/provider';
import { nobleProvider } from '../crypto/noble';
import type { RequestClient } from '../api/transport';
import { call } from '../api/transport';
import { NotFoundError } from '../api/errors';
import { getBackup, putBackup } from '../api/backup';
import { listDevices } from '../api/devices';
import { createBackup, restoreBackup, validateKdf } from '../format/backup';
import { toBase64Url } from '../format/base64url';
import type { DeviceManager } from '../device/manager';
import type { SecureMessaging } from '../messaging/secure';
import { DeviceStateError } from '../device/errors';
import { classifySecret, generateRecoveryCode } from './recoveryCode';
import { BackupCostTooHighError, BackupDeviceGoneError, NoBackupError, WeakSecretError } from './errors';

/** Stronger than the format's OWASP minimum, because a backup is attacked offline with the server's copy: 64 MiB, 3 passes. About 1-3 s on a laptop in pure JS, more on a phone: run it in a Web Worker if that matters. */
export const BACKUP_PARAMS = { m: 65536, t: 3, p: 1 } as const;
/** What restore will agree to run, whatever the server's header asks. */
export const MAX_RESTORE_PARAMS = { m: 262144, t: 8, p: 4 } as const;

export interface BackupManagerOptions {
  client: RequestClient; device: DeviceManager; secure?: SecureMessaging; userId: string; provider?: CryptoProvider;
  /** Argon2id cost for new backups. Default BACKUP_PARAMS. Stored in the header, so it can be raised later. */
  params?: { m: number; t: number; p: number };
  /** Shortest passphrase accepted (in characters). Default 12. Recovery codes are always accepted. */
  minPassphraseLength?: number;
  /** Upper bound on the KDF cost a restore will run. Default MAX_RESTORE_PARAMS. */
  maxParams?: { m: number; t: number; p: number };
}
export interface BackupStatus { exists: boolean; updatedAt?: string; params?: { m: number; t: number; p: number } }
export interface RestoreResult {
  deviceId: string; role: 'primary' | 'companion';
  /** Encrypted conversations this account is in, and for how many of them at least one key was fetched. */
  conversations: { total: number; withKeys: number; failed: Array<{ conversationId: string; error: unknown }> };
}
type Progress = (fraction: number) => void;

export function createBackupManager(o: BackupManagerOptions) {
  const { client, device, secure, userId } = o;
  const provider = o.provider ?? nobleProvider;
  const params = o.params ?? BACKUP_PARAMS;
  const minLen = o.minPassphraseLength ?? 12;
  const max = o.maxParams ?? MAX_RESTORE_PARAMS;

  function secretFor(input: string) {
    const s = classifySecret(input, provider);
    if (s.kind === 'passphrase' && [...s.secret].length < minLen) throw new WeakSecretError(minLen);
    return s;
  }

  return {
    /** 160 random bits as `ABCD-EFGH-…` with check characters. The recommended secret: store it somewhere safe, off the device. */
    generateRecoveryCode: () => generateRecoveryCode(provider),

    /**
     * Encrypt this device's private key under `secret` (a recovery code, or a passphrase of at least `minPassphraseLength` characters)
     * and store it on the server, replacing any earlier backup of this account. The server never sees the secret or the key.
     */
    async create(secret: string, opts: { onProgress?: Progress; params?: { m: number; t: number; p: number } } = {}): Promise<{ updatedAt: string; kind: 'recovery-code' | 'passphrase'; params: { m: number; t: number; p: number } }> {
      const s = secretFor(secret);
      const me = await device.requireDevice();
      const use = opts.params ?? params;
      const { blob, kdf } = await createBackup({ deviceId: me.deviceId, privateKey: me.privateKey }, s.secret, use, { provider, onProgress: opts.onProgress });
      const res = await putBackup(client, { blob, kdf });
      return { updatedAt: res.updatedAt, kind: s.kind, params: { m: kdf.m, t: kdf.t, p: kdf.p } };
    },

    /** Whether a backup exists, when it was made and how costly it is to open. Does not need the secret. */
    async status(): Promise<BackupStatus> {
      try { const b = await getBackup(client); const k = validateKdf(b.kdf); return { exists: true, updatedAt: b.updatedAt, params: { m: k.m, t: k.t, p: k.p } }; }
      catch (e) { if (e instanceof NotFoundError) return { exists: false }; throw e; }
    },

    /**
     * On a device with no identity: open the backup, check the server still knows that device and its key, adopt it, and fetch every
     * conversation key this device is entitled to. A wrong secret or a changed backup throws DecryptError (the two look the same on purpose).
     * Throws DeviceStateError when this device already has an identity.
     */
    async restore(secret: string, opts: { onProgress?: Progress; fetchKeys?: boolean } = {}): Promise<RestoreResult> {
      const s = classifySecret(secret, provider); // a typo in a recovery code fails here, before the slow part
      const st = await device.state();
      if (st === 'primary' || st === 'companion') throw new DeviceStateError('This device already has an identity; restoring would replace it', st);
      let record;
      try { record = await getBackup(client); } catch (e) { if (e instanceof NotFoundError) throw new NoBackupError(); throw e; }
      const kdf = validateKdf(record.kdf);
      if (kdf.m > max.m || kdf.t > max.t || kdf.p > max.p) throw new BackupCostTooHighError({ m: kdf.m, t: kdf.t, p: kdf.p });
      const payload = await restoreBackup(record, s.secret, { provider, onProgress: opts.onProgress });
      const publicKey = provider.publicKeyFor(payload.privateKey);
      const row = (await listDevices(client, [userId])).find((d) => d.id === payload.deviceId);
      if (!row) throw new BackupDeviceGoneError(payload.deviceId, 'revoked');
      if (row.publicKey !== toBase64Url(publicKey)) throw new BackupDeviceGoneError(payload.deviceId, 'key-mismatch');
      const role = row.isPrimary ? 'primary' : 'companion';
      await device.importDevice({ deviceId: payload.deviceId, privateKey: payload.privateKey, publicKey, role });
      const conversations = { total: 0, withKeys: 0, failed: [] as Array<{ conversationId: string; error: unknown }> };
      if (opts.fetchKeys !== false && secure) {
        const ids = await encryptedConversationIds();
        conversations.total = ids.length;
        for (let i = 0; i < ids.length; i += 4) {
          await Promise.all(ids.slice(i, i + 4).map(async (id) => {
            try {
              const err = await secure.refreshKeys(id); // resolves to the first key that failed to open, if any
              if ((await secure.heldVersions(id)).length) conversations.withKeys++; else conversations.failed.push({ conversationId: id, error: err ?? new Error('no key for this device in this conversation') });
            } catch (error) { conversations.failed.push({ conversationId: id, error }); }
          }));
        }
      }
      return { deviceId: payload.deviceId, role, conversations };
    },
  };

  async function encryptedConversationIds(): Promise<string[]> {
    const out: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const rows = await call<Array<{ id: string; encryption_mode?: string }>>(client, 'GET', '/conversations', { query: { userId, limit: 100, offset } });
      for (const r of rows) if (r.encryption_mode === 'e2ee-v1') out.push(r.id);
      if (rows.length < 100) return out;
    }
  }
}
export type BackupManager = ReturnType<typeof createBackupManager>;
