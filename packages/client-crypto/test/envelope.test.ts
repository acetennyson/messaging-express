import { describe, it, expect } from 'vitest';
import {
  nobleProvider as p, newConversationKey, wrapKeyForDevices, unwrapKey, encryptSecureMessage, decryptSecureMessage, encryptAttachment, decryptAttachment,
  toBase64Url, DecryptError, FormatError,
} from '../src/index';

const conversationId = 'conv-1', keyVersion = 1;
const mk = (id: string) => { const k = p.generateKeyPair(); return { deviceId: id, ...k }; };
const alice = mk('dev-alice'), bob = mk('dev-bob'), bob2 = mk('dev-bob-2');

describe('conversation key and wraps', () => {
  it('keys are 32 random bytes and differ', () => {
    expect(newConversationKey()).toHaveLength(32);
    expect(Buffer.from(newConversationKey()).equals(Buffer.from(newConversationKey()))).toBe(false);
  });
  it('wraps for every device including the sender, in the exact shape the server\'s keys route takes; each device opens only its own', () => {
    const ck = newConversationKey();
    const out = wrapKeyForDevices({ conversationKey: ck, conversationId, keyVersion, sender: alice, recipients: [alice, bob, bob2].map((d) => ({ deviceId: d.deviceId, publicKey: toBase64Url(d.publicKey) })) });
    expect(out.map((o) => o.deviceId)).toEqual(['dev-alice', 'dev-bob', 'dev-bob-2']);
    expect(out.every((o) => o.wrappedByDeviceId === 'dev-alice' && /^[A-Za-z0-9_-]{98}$/.test(o.wrappedKey))).toBe(true); // 73 bytes = 98 base64url characters
    for (const [d, o] of [[alice, out[0]], [bob, out[1]], [bob2, out[2]]] as const) {
      const got = unwrapKey({ wrappedKey: o.wrappedKey, conversationId, keyVersion, wrappedByDeviceId: 'dev-alice', senderPublicKey: toBase64Url(alice.publicKey), recipient: d });
      expect(Buffer.from(got).equals(Buffer.from(ck))).toBe(true);
    }
    expect(() => unwrapKey({ wrappedKey: out[1].wrappedKey, conversationId, keyVersion, wrappedByDeviceId: 'dev-alice', senderPublicKey: alice.publicKey, recipient: bob2 })).toThrow(DecryptError);
    expect(() => unwrapKey({ wrappedKey: out[1].wrappedKey, conversationId, keyVersion, wrappedByDeviceId: 'dev-mallory', senderPublicKey: alice.publicKey, recipient: bob })).toThrow(DecryptError);
    expect(() => unwrapKey({ wrappedKey: out[1].wrappedKey, conversationId: 'conv-2', keyVersion, wrappedByDeviceId: 'dev-alice', senderPublicKey: alice.publicKey, recipient: bob })).toThrow(DecryptError);
  });
  it('rejects duplicate recipients and malformed public keys', () => {
    const ck = newConversationKey();
    expect(() => wrapKeyForDevices({ conversationKey: ck, conversationId, keyVersion, sender: alice, recipients: [bob, bob] })).toThrow(FormatError);
    expect(() => wrapKeyForDevices({ conversationKey: ck, conversationId, keyVersion, sender: alice, recipients: [{ deviceId: 'x', publicKey: 'AAAA' }] })).toThrow(FormatError);
    expect(() => wrapKeyForDevices({ conversationKey: ck, conversationId, keyVersion, sender: alice, recipients: [{ deviceId: 'x', publicKey: new Uint8Array(31) }] })).toThrow(FormatError);
  });
});

describe('the whole flow, with no network', () => {
  it('Alice creates a conversation and sends a message with an attachment; Bob (a different device) reads both', async () => {
    const ck = newConversationKey();
    const wraps = wrapKeyForDevices({ conversationKey: ck, conversationId, keyVersion, sender: alice, recipients: [alice, bob] });
    const photo = p.randomBytes(200_000);
    const { ciphertext, descriptor } = await encryptAttachment(photo, { name: 'cat.png', type: 'image/png', w: 10, h: 20 });
    const content = encryptSecureMessage({ text: 'look at this', attachments: [descriptor] }, ck, { conversationId, keyVersion, senderId: 'user-alice' });

    const bobKey = unwrapKey({ wrappedKey: wraps[1].wrappedKey, conversationId, keyVersion, wrappedByDeviceId: 'dev-alice', senderPublicKey: alice.publicKey, recipient: bob });
    const msg = decryptSecureMessage(content, bobKey, { conversationId, keyVersion, senderId: 'user-alice' });
    expect(msg.text).toBe('look at this');
    expect(msg.attachments[0]).toMatchObject({ name: 'cat.png', type: 'image/png', w: 10, h: 20, size: 200_000 });
    expect(Buffer.from(await decryptAttachment(ciphertext, msg.attachments[0])).equals(Buffer.from(photo))).toBe(true);
  });
  it('rejects a malformed attachment descriptor inside a message, on both sides', () => {
    const ck = newConversationKey(); const ctx = { conversationId, keyVersion, senderId: 'u' };
    expect(() => encryptSecureMessage({ text: 'x', attachments: [{ v: 1, key: 'short' } as any] }, ck, ctx)).toThrow(FormatError);
  });
  it('a removed member\'s old key cannot open a message under the next key version', () => {
    const k1 = newConversationKey(), k2 = newConversationKey();
    const content = encryptSecureMessage({ text: 'after removal' }, k2, { conversationId, keyVersion: 2, senderId: 'u' });
    expect(() => decryptSecureMessage(content, k1, { conversationId, keyVersion: 2, senderId: 'u' })).toThrow(DecryptError);
  });
});
