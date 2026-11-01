import { FormatError } from './errors';

export const VERSION = 0x01;
export const NONCE_LENGTH = 24;
export const TAG_LENGTH = 16;
export const KEY_LENGTH = 32;
export const PAD_BLOCK = 64;

const enc = new TextEncoder();
export const utf8 = (s: string): Uint8Array => enc.encode(s);

function id(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) throw new FormatError('BAD_INPUT', `${name} must be a non-empty string of at most 128 characters`);
  // '|' separates the fields of the AAD; allowing it inside an id would let two different contexts produce the same bytes.
  if (value.includes('|')) throw new FormatError('BAD_INPUT', `${name} must not contain "|"`);
  return value;
}
function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new FormatError('BAD_INPUT', 'keyVersion must be an integer >= 1');
  return value;
}

/** Everything a wrapped conversation key is bound to. */
export interface WrapContext {
  conversationId: string;
  keyVersion: number;
  senderDeviceId: string;
  recipientDeviceId: string;
}
/** Everything an encrypted message is bound to. `senderId` is the sender's USER id (the same value the server stores as sender_id). */
export interface MessageContext {
  conversationId: string;
  keyVersion: number;
  senderId: string;
}

/** HKDF `info` and AEAD AAD for a wrapped key. */
export function wrapInfo(c: WrapContext): Uint8Array {
  return utf8(`mx-e2ee-v1|wrap|${id('conversationId', c.conversationId)}|${version(c.keyVersion)}|${id('senderDeviceId', c.senderDeviceId)}|${id('recipientDeviceId', c.recipientDeviceId)}`);
}
/** AEAD AAD for a message. */
export function messageAad(c: MessageContext): Uint8Array {
  return utf8(`mx-e2ee-v1|msg|${id('conversationId', c.conversationId)}|${version(c.keyVersion)}|${id('senderId', c.senderId)}`);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function requireBytes(name: string, v: unknown, length?: number): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new FormatError('BAD_INPUT', `${name} must be a Uint8Array`);
  if (length !== undefined && v.length !== length) throw new FormatError('BAD_INPUT', `${name} must be ${length} bytes`);
  return v;
}

/** Best-effort wipe. JavaScript gives no guarantee that copies were not made elsewhere; this only removes the obvious one. */
export function zeroize(...buffers: Uint8Array[]): void {
  for (const b of buffers) b.fill(0);
}
