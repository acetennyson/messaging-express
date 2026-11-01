import { nobleProvider } from '../crypto/noble';
import type { CryptoProvider } from '../crypto/provider';
import { fromBase64Url, toBase64Url } from './base64url';
import { FormatError } from './errors';
import { KEY_LENGTH, NONCE_LENGTH, TAG_LENGTH, VERSION, concat, requireBytes, wrapInfo, zeroize, type WrapContext } from './context';

/** 0x01 | nonce(24) | XChaCha20-Poly1305(conversationKey)  = 1 + 24 + 32 + 16 = 73 bytes. */
export const WRAPPED_KEY_LENGTH = 1 + NONCE_LENGTH + KEY_LENGTH + TAG_LENGTH;

export interface WireOptions {
  provider?: CryptoProvider;
  /** TESTS ONLY: a fixed nonce, to produce reproducible vectors. Reusing a nonce under one key breaks the cipher. */
  nonce?: Uint8Array;
}

function wrapKeyBytes(c: CryptoProvider, ownPrivate: Uint8Array, otherPublic: Uint8Array, ctx: WrapContext): { key: Uint8Array; info: Uint8Array } {
  const info = wrapInfo(ctx);
  const shared = c.ecdh(ownPrivate, otherPublic);
  const key = c.hkdf(shared, info, 32);
  zeroize(shared);
  return { key, info };
}

/** Seal a conversation key for ONE recipient device. Static-static ECDH, so only the holder of the sender device's private key could have produced it. */
export function wrapConversationKey(conversationKey: Uint8Array, ctx: WrapContext, senderPrivateKey: Uint8Array, recipientPublicKey: Uint8Array, opts: WireOptions = {}): string {
  const c = opts.provider ?? nobleProvider;
  requireBytes('conversationKey', conversationKey, KEY_LENGTH);
  requireBytes('senderPrivateKey', senderPrivateKey, 32);
  requireBytes('recipientPublicKey', recipientPublicKey, 32);
  const nonce = opts.nonce ?? c.randomBytes(NONCE_LENGTH);
  requireBytes('nonce', nonce, NONCE_LENGTH);
  const { key, info } = wrapKeyBytes(c, senderPrivateKey, recipientPublicKey, ctx);
  try {
    return toBase64Url(concat(new Uint8Array([VERSION]), nonce, c.aeadEncrypt(key, nonce, conversationKey, info)));
  } finally {
    zeroize(key);
  }
}

/** Open a wrapped conversation key on the recipient device. Throws FormatError for a malformed blob, DecryptError if it does not authenticate. */
export function unwrapConversationKey(blob: string, ctx: WrapContext, recipientPrivateKey: Uint8Array, senderPublicKey: Uint8Array, opts: WireOptions = {}): Uint8Array {
  const c = opts.provider ?? nobleProvider;
  requireBytes('recipientPrivateKey', recipientPrivateKey, 32);
  requireBytes('senderPublicKey', senderPublicKey, 32);
  const bytes = fromBase64Url(blob);
  if (bytes.length !== WRAPPED_KEY_LENGTH) throw new FormatError('BAD_LENGTH', `a wrapped key is exactly ${WRAPPED_KEY_LENGTH} bytes, got ${bytes.length}`);
  if (bytes[0] !== VERSION) throw new FormatError('UNKNOWN_VERSION', `unknown wrapped-key version ${bytes[0]}`);
  const { key, info } = wrapKeyBytes(c, recipientPrivateKey, senderPublicKey, ctx);
  try {
    return c.aeadDecrypt(key, bytes.subarray(1, 1 + NONCE_LENGTH), bytes.subarray(1 + NONCE_LENGTH), info);
  } finally {
    zeroize(key);
  }
}
