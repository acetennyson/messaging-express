import { call, type RequestClient } from './transport';
import type { BackupKdf } from '../format/backup';

export interface BackupRecord { blob: string; kdf: BackupKdf; updatedAt: string }

/** PUT /devices/backup: store the passphrase-encrypted key backup (replaces the previous one). Not a [Dev] route. */
export const putBackup = (c: RequestClient, input: { blob: string; kdf: BackupKdf }, signal?: AbortSignal) =>
  call<{ updatedAt: string }>(c, 'PUT', '/devices/backup', { body: input, signal });

/** GET /devices/backup. Rejects with NotFoundError when there is none. */
export const getBackup = (c: RequestClient, signal?: AbortSignal) => call<BackupRecord>(c, 'GET', '/devices/backup', { signal });

/** DELETE /devices/backup. */
export const deleteBackup = (c: RequestClient, signal?: AbortSignal) => call<{ deleted: true }>(c, 'DELETE', '/devices/backup', { signal });
