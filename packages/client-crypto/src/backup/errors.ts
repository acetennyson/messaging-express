/** The secret is too easy to guess offline (a short passphrase). Use a recovery code, or a longer passphrase. */
export class WeakSecretError extends Error { constructor(public readonly minLength: number) { super(`That passphrase is too short: use at least ${minLength} characters, or a generated recovery code (backup.generateRecoveryCode()).`); this.name = 'WeakSecretError'; } }
/** Looks like a recovery code but the check characters do not match: a typo. Raised before any slow key derivation. */
export class InvalidRecoveryCodeError extends Error { constructor() { super('That recovery code has a typo: its check characters do not match.'); this.name = 'InvalidRecoveryCodeError'; } }
/** There is no backup on the server for this user. */
export class NoBackupError extends Error { constructor() { super('There is no backup for this account.'); this.name = 'NoBackupError'; } }
/** The server's backup header asks for more memory or time than the restore limit. A malicious server could otherwise freeze or crash the client. Raise `maxParams` only if you chose those parameters yourself. */
export class BackupCostTooHighError extends Error { constructor(public readonly asked: { m: number; t: number; p: number }) { super(`The backup asks for Argon2id m=${asked.m} KiB, t=${asked.t}, p=${asked.p}, which is above the restore limit.`); this.name = 'BackupCostTooHighError'; } }
/** The backup opened, but the device inside it no longer exists or no longer matches on the server (revoked since, or a mixed-up account). */
export class BackupDeviceGoneError extends Error { constructor(public readonly deviceId: string, reason: 'revoked' | 'key-mismatch') { super(reason === 'revoked' ? 'The device in this backup was revoked after the backup was made. Link this device from another one, or ask an admin to reset your devices.' : 'The server lists a different key for the device in this backup. Not restoring.'); this.name = 'BackupDeviceGoneError'; } }
