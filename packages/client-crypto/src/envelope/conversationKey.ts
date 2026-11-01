import { nobleProvider } from '../crypto/noble';
import type { CryptoProvider } from '../crypto/provider';
import { KEY_LENGTH } from '../format/context';

/** A fresh random 256-bit conversation key. Generated on the creating device and never sent anywhere except wrapped per device. */
export function newConversationKey(provider: CryptoProvider = nobleProvider): Uint8Array {
  return provider.randomBytes(KEY_LENGTH);
}
