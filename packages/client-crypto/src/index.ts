// @messaging-express/client-crypto. C1: wire format and primitives. C2: key stores. Devices, envelope operations and the client API arrive in C3 to C10.
// The byte layouts are specified in WIRE_FORMAT.md and frozen: a change needs a new version byte, not an edit.
export const PACKAGE_NAME = '@messaging-express/client-crypto';

export type { CryptoProvider } from './crypto/provider';
export { nobleProvider } from './crypto/noble';
export { toBase64Url, fromBase64Url } from './format/base64url';
export { FormatError, DecryptError, type FormatErrorCode } from './format/errors';
export { wrapInfo, messageAad, type WrapContext, type MessageContext } from './format/context';
export { pad, unpad } from './format/padding';
export { wrapConversationKey, unwrapConversationKey, WRAPPED_KEY_LENGTH, type WireOptions } from './format/wrap';
export { encryptMessage, decryptMessage, MIN_MESSAGE_LENGTH, type MessageContent } from './format/message';
export { createBackup, restoreBackup, validateKdf, backupAad, DEFAULT_BACKUP_PARAMS, type BackupKdf, type BackupPayload } from './format/backup';
export type { CryptoKeyStore } from './keystore/types';
export { MAX_KEY_LENGTH } from './keystore/types';
export { memoryKeyStore } from './keystore/memory';
export { scopedKeyStore, scopePrefix, clearKeyStore, keyNames, type KeyStoreScope } from './keystore/scope';
