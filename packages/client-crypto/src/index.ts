// @messaging-express/client-crypto. C1: wire format and primitives. C2: key stores. C3: envelope operations (keys, messages, attachments). Devices and the client API arrive in C4 to C10.
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
export { newConversationKey } from './envelope/conversationKey';
export { wrapKeyForDevices, unwrapKey, type WrappedKeyForDevice, type PublicKeyInput } from './envelope/wrap';
export { encryptSecureMessage, decryptSecureMessage, type SecureMessage } from './envelope/message';
export {
  encryptAttachment, decryptAttachment, encryptAttachmentStream, decryptAttachmentStream, parseAttachmentDescriptor, ATTACHMENT_CHUNK_SIZE,
  type AttachmentDescriptor, type AttachmentMeta, type ByteSource, type AttachmentOptions,
} from './envelope/attachment';

// C4: API layer
export { withCrypto, createCryptoApi, type WithCryptoOptions, type CryptoApi, type CryptoNamespace } from './withCrypto';
export { call as apiCall, type RequestClient, type CallOptions } from './api/transport';
export * from './api/errors';
export { registerDevice, listDevices, revokeDevice, pairDevice, linkDevice, resetUserDevices, type DeviceInfo, type RegisteredDevice, type LinkedDevice } from './api/devices';
export { putBackup, getBackup, deleteBackup, type BackupRecord } from './api/backup';
export { getKeys, uploadKeys, requestKeys, type KeyEntry, type KeyRow } from './api/keys';
export { createEncryptedConversation, addParticipant, removeParticipant, postEncryptedMessage, type E2eeConversation, type CreateEncryptedConversationInput, type PostMessageInput } from './api/conversations';
