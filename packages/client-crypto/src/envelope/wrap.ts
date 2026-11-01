import { nobleProvider } from '../crypto/noble';
import type { CryptoProvider } from '../crypto/provider';
import { fromBase64Url } from '../format/base64url';
import { FormatError } from '../format/errors';
import { requireBytes } from '../format/context';
import { unwrapConversationKey, wrapConversationKey } from '../format/wrap';

/** A public key as the server returns it (base64url) or as raw bytes. */
export type PublicKeyInput = string | Uint8Array;
function publicKeyBytes(k: PublicKeyInput, what: string): Uint8Array {
  const b = typeof k === 'string' ? fromBase64Url(k) : k;
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new FormatError('BAD_INPUT', `${what} must be a 32-byte X25519 public key`);
  return b;
}

/** One entry of the `keys` array the server expects on POST /conversations/:id/keys and when creating an encrypted conversation. */
export interface WrappedKeyForDevice { deviceId: string; wrappedKey: string; wrappedByDeviceId: string }

/**
 * Seal one conversation key for every recipient device. Include the sender's OWN device(s) so it can read its own conversation after a reload.
 * The server insists on exactly the conversation's current device set, so fetch the participants' active devices first.
 */
export function wrapKeyForDevices(input: {
  conversationKey: Uint8Array;
  conversationId: string;
  keyVersion: number;
  sender: { deviceId: string; privateKey: Uint8Array; publicKey?: PublicKeyInput };
  recipients: Array<{ deviceId: string; publicKey: PublicKeyInput }>;
  provider?: CryptoProvider;
}): WrappedKeyForDevice[] {
  const provider = input.provider ?? nobleProvider;
  requireBytes('sender.privateKey', input.sender.privateKey, 32);
  const seen = new Set<string>();
  return input.recipients.map((r) => {
    if (seen.has(r.deviceId)) throw new FormatError('BAD_INPUT', `duplicate recipient device ${r.deviceId}`);
    seen.add(r.deviceId);
    const wrappedKey = wrapConversationKey(
      input.conversationKey,
      { conversationId: input.conversationId, keyVersion: input.keyVersion, senderDeviceId: input.sender.deviceId, recipientDeviceId: r.deviceId },
      input.sender.privateKey, publicKeyBytes(r.publicKey, `recipient ${r.deviceId} publicKey`), { provider },
    );
    return { deviceId: r.deviceId, wrappedKey, wrappedByDeviceId: input.sender.deviceId };
  });
}

/** Open the wrapped key addressed to this device. `sender.publicKey` is the public key of `wrappedByDeviceId`, from the server's device list. */
export function unwrapKey(input: {
  wrappedKey: string;
  conversationId: string;
  keyVersion: number;
  wrappedByDeviceId: string;
  senderPublicKey: PublicKeyInput;
  recipient: { deviceId: string; privateKey: Uint8Array };
  provider?: CryptoProvider;
}): Uint8Array {
  return unwrapConversationKey(
    input.wrappedKey,
    { conversationId: input.conversationId, keyVersion: input.keyVersion, senderDeviceId: input.wrappedByDeviceId, recipientDeviceId: input.recipient.deviceId },
    input.recipient.privateKey, publicKeyBytes(input.senderPublicKey, 'senderPublicKey'), { provider: input.provider },
  );
}
