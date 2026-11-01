import { nobleProvider } from '../crypto/noble';
import { fromBase64Url, toBase64Url } from './base64url';
import { FormatError } from './errors';
import { KEY_LENGTH, NONCE_LENGTH, PAD_BLOCK, TAG_LENGTH, VERSION, concat, messageAad, requireBytes, utf8, type MessageContext } from './context';
import { pad, unpad } from './padding';
import type { WireOptions } from './wrap';

/** Smallest possible message blob: version + nonce + one padded block + tag. The server only requires >= 41 bytes and a leading 0x01. */
export const MIN_MESSAGE_LENGTH = 1 + NONCE_LENGTH + PAD_BLOCK + TAG_LENGTH;

/** What goes inside the encrypted payload. Attachment descriptors are defined in C3; here they are opaque JSON objects. */
export interface MessageContent {
  text: string;
  attachments?: Array<Record<string, unknown>>;
}

const dec = new TextDecoder('utf-8', { fatal: true });

/** 0x01 | nonce(24) | XChaCha20-Poly1305(pad64(JSON {v:1,t,a}))  under the conversation key. Returns base64url, ready for messages.content. */
export function encryptMessage(content: MessageContent, conversationKey: Uint8Array, ctx: MessageContext, opts: WireOptions = {}): string {
  const c = opts.provider ?? nobleProvider;
  requireBytes('conversationKey', conversationKey, KEY_LENGTH);
  if (typeof content?.text !== 'string') throw new FormatError('BAD_INPUT', 'content.text must be a string');
  const nonce = opts.nonce ?? c.randomBytes(NONCE_LENGTH);
  requireBytes('nonce', nonce, NONCE_LENGTH);
  const payload = pad(utf8(JSON.stringify({ v: 1, t: content.text, a: content.attachments ?? [] })));
  return toBase64Url(concat(new Uint8Array([VERSION]), nonce, c.aeadEncrypt(conversationKey, nonce, payload, messageAad(ctx))));
}

export function decryptMessage(blob: string, conversationKey: Uint8Array, ctx: MessageContext, opts: WireOptions = {}): { text: string; attachments: Array<Record<string, unknown>> } {
  const c = opts.provider ?? nobleProvider;
  requireBytes('conversationKey', conversationKey, KEY_LENGTH);
  const bytes = fromBase64Url(blob);
  if (bytes.length < MIN_MESSAGE_LENGTH || (bytes.length - 1 - NONCE_LENGTH - TAG_LENGTH) % PAD_BLOCK !== 0) throw new FormatError('BAD_LENGTH', 'not a valid message blob length');
  if (bytes[0] !== VERSION) throw new FormatError('UNKNOWN_VERSION', `unknown message version ${bytes[0]}`);
  const plain = unpad(c.aeadDecrypt(conversationKey, bytes.subarray(1, 1 + NONCE_LENGTH), bytes.subarray(1 + NONCE_LENGTH), messageAad(ctx)));
  let parsed: any;
  try {
    parsed = JSON.parse(dec.decode(plain));
  } catch {
    throw new FormatError('BAD_PAYLOAD', 'payload is not valid UTF-8 JSON');
  }
  if (!parsed || parsed.v !== 1 || typeof parsed.t !== 'string' || !Array.isArray(parsed.a)) throw new FormatError('BAD_PAYLOAD', 'unsupported payload shape');
  return { text: parsed.t, attachments: parsed.a };
}
