import type { CryptoProvider } from '../crypto/provider';
import { decryptMessage as decryptRaw, encryptMessage as encryptRaw } from '../format/message';
import type { MessageContext } from '../format/context';
import { parseAttachmentDescriptor, type AttachmentDescriptor } from './attachment';

export interface SecureMessage { text: string; attachments?: AttachmentDescriptor[] }

/** Encrypt text and attachment descriptors into the string for `messages.content`; pair it with `metadata: { scheme: 'ck-xchacha-v1', key_version }`. */
export function encryptSecureMessage(message: SecureMessage, conversationKey: Uint8Array, ctx: MessageContext, opts: { provider?: CryptoProvider } = {}): string {
  for (const a of message.attachments ?? []) parseAttachmentDescriptor(a);
  return encryptRaw({ text: message.text, attachments: message.attachments as unknown as Array<Record<string, unknown>> }, conversationKey, ctx, opts);
}

/** Decrypt a message. Attachment descriptors are validated, so a malformed one is a FormatError here and not a crash later. */
export function decryptSecureMessage(content: string, conversationKey: Uint8Array, ctx: MessageContext, opts: { provider?: CryptoProvider } = {}): { text: string; attachments: AttachmentDescriptor[] } {
  const m = decryptRaw(content, conversationKey, ctx, opts);
  return { text: m.text, attachments: m.attachments.map(parseAttachmentDescriptor) };
}
