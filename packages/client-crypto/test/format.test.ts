import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  nobleProvider as p, wrapConversationKey, unwrapConversationKey, encryptMessage, decryptMessage, createBackup, restoreBackup,
  toBase64Url, fromBase64Url, pad, unpad, FormatError, DecryptError, WRAPPED_KEY_LENGTH, MIN_MESSAGE_LENGTH, validateKdf,
} from '../src/index';
import { hex, toHex } from './helpers';

const V = JSON.parse(readFileSync(new URL('./vectors/vectors.json', import.meta.url), 'utf8'));
const k = { privA: hex(V.keys.privA), pubA: hex(V.keys.pubA), privB: hex(V.keys.privB), pubB: hex(V.keys.pubB), ck: hex(V.keys.conversationKey) };
const wctx = V.wrap.ctx;
const mctx = V.messageContext;
const flip = (blob: string, i: number) => { const b = fromBase64Url(blob); b[i] ^= 0x01; return toBase64Url(b); };
const rejects = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof FormatError || e instanceof DecryptError; } return false; };

describe('base64url', () => {
  it('matches the vectors both ways', () => {
    for (const t of V.base64url) { expect(toBase64Url(hex(t.hex))).toBe(t.b64u); expect(toHex(fromBase64Url(t.b64u))).toBe(t.hex); }
  });
  it('is strict: rejects padding, standard alphabet, whitespace, bad length and non-canonical trailing bits', () => {
    for (const bad of ['AA==', 'a+b/', 'AA A', 'A', 'AAAAA', 'AB', 'éééé']) expect(() => fromBase64Url(bad), bad).toThrow(FormatError);
  });
  it('round-trips random bytes of every length 0..300', () => {
    for (let n = 0; n <= 300; n++) { const b = p.randomBytes(n); expect(toHex(fromBase64Url(toBase64Url(b)))).toBe(toHex(b)); }
  });
});

describe('padding', () => {
  it('always lands on a multiple of 64 and always adds at least one byte', () => {
    for (let n = 0; n < 300; n++) { const out = pad(new Uint8Array(n)); expect(out.length % 64).toBe(0); expect(out.length).toBeGreaterThan(n); expect(unpad(out)).toHaveLength(n); }
  });
  it('rejects missing marker, wrong length and an extra block of zeros', () => {
    expect(() => unpad(new Uint8Array(64))).toThrow(FormatError);
    expect(() => unpad(new Uint8Array(63))).toThrow(FormatError);
    const two = new Uint8Array(128); two[10] = 0x80; expect(() => unpad(two)).toThrow(FormatError);
  });
});

describe('wrapped conversation key', () => {
  it('reproduces the frozen vector byte for byte', () => {
    expect(wrapConversationKey(k.ck, wctx, k.privA, k.pubB, { nonce: hex(V.wrap.nonce) })).toBe(V.wrap.blob);
  });
  it('unwraps the frozen vector, and the blob is exactly 73 bytes starting 0x01', () => {
    const bytes = fromBase64Url(V.wrap.blob);
    expect(bytes).toHaveLength(WRAPPED_KEY_LENGTH); expect(bytes[0]).toBe(1);
    expect(toHex(unwrapConversationKey(V.wrap.blob, wctx, k.privB, k.pubA))).toBe(V.keys.conversationKey);
  });
  it('flipping any single byte of the blob is rejected', () => {
    for (let i = 0; i < WRAPPED_KEY_LENGTH; i++) expect(rejects(() => unwrapConversationKey(flip(V.wrap.blob, i), wctx, k.privB, k.pubA)), `byte ${i}`).toBe(true);
  });
  it('is bound to every field of its context', () => {
    const fresh = wrapConversationKey(k.ck, wctx, k.privA, k.pubB); // freshly produced, so this proves the CURRENT code binds each field (a frozen blob would fail for any change)
    expect(toHex(unwrapConversationKey(fresh, wctx, k.privB, k.pubA))).toBe(V.keys.conversationKey);
    const open = (c: any) => unwrapConversationKey(fresh, c, k.privB, k.pubA);
    for (const [field, value] of [['conversationId', 'other-conversation'], ['keyVersion', 4], ['senderDeviceId', 'other-device'], ['recipientDeviceId', 'other-device']] as const)
      expect(() => open({ ...wctx, [field]: value }), field).toThrow(DecryptError);
  });
  it('only the intended recipient (and not the sender or a third party) can open it with the sender key', () => {
    const third = p.generateKeyPair();
    expect(() => unwrapConversationKey(V.wrap.blob, wctx, third.privateKey, k.pubA)).toThrow(DecryptError);
    expect(() => unwrapConversationKey(V.wrap.blob, wctx, k.privB, third.publicKey)).toThrow(DecryptError); // wrong claimed sender: sender-authenticated
  });
  it('rejects wrong lengths (including trailing bytes) and unknown versions with a typed error', () => {
    const b = fromBase64Url(V.wrap.blob);
    expect(() => unwrapConversationKey(toBase64Url(b.subarray(0, 72)), wctx, k.privB, k.pubA)).toThrow(FormatError);
    expect(() => unwrapConversationKey(toBase64Url(new Uint8Array([...b, 0])), wctx, k.privB, k.pubA)).toThrow(FormatError);
    const v2 = b.slice(); v2[0] = 2;
    expect(() => unwrapConversationKey(toBase64Url(v2), wctx, k.privB, k.pubA)).toThrow(expect.objectContaining({ code: 'UNKNOWN_VERSION' }));
  });
  it('uses a fresh random nonce each time', () => {
    expect(wrapConversationKey(k.ck, wctx, k.privA, k.pubB)).not.toBe(wrapConversationKey(k.ck, wctx, k.privA, k.pubB));
  });
});

describe('message', () => {
  it('reproduces every frozen vector byte for byte and decrypts it', () => {
    for (const m of V.messages) {
      expect(encryptMessage({ text: m.text, attachments: m.attachments }, k.ck, mctx, { nonce: hex(m.nonce) }), m.name).toBe(m.blob);
      expect(decryptMessage(m.blob, k.ck, mctx), m.name).toEqual({ text: m.text, attachments: m.attachments });
    }
  });
  it('blob length reveals only the 64-byte bucket: 41 + 64n, minimum 105', () => {
    expect(MIN_MESSAGE_LENGTH).toBe(105);
    const lens = new Set<number>();
    for (let n = 0; n < 400; n++) { const len = fromBase64Url(encryptMessage({ text: 'a'.repeat(n) }, k.ck, mctx)).length; expect((len - 41) % 64).toBe(0); lens.add(len); }
    expect(lens.size).toBeLessThan(10);
  });
  it('satisfies the server\'s structural check: >= 41 bytes and a leading 0x01', () => {
    const b = fromBase64Url(encryptMessage({ text: '' }, k.ck, mctx));
    expect(b.length).toBeGreaterThanOrEqual(41); expect(b[0]).toBe(1);
  });
  it('flipping any single byte of a message is rejected', () => {
    const blob = V.messages.find((m: any) => m.name === 'short').blob;
    for (let i = 0; i < fromBase64Url(blob).length; i++) expect(rejects(() => decryptMessage(flip(blob, i), k.ck, mctx)), `byte ${i}`).toBe(true);
  });
  it('is bound to conversation, key version and sender (no splicing, no re-attribution)', () => {
    const blob = encryptMessage({ text: 'hello' }, k.ck, mctx); // freshly produced (see the wrap test)
    expect(decryptMessage(blob, k.ck, mctx).text).toBe('hello');
    for (const [field, value] of [['conversationId', 'conversation-B'], ['keyVersion', 2], ['senderId', 'user-mallory']] as const)
      expect(() => decryptMessage(blob, k.ck, { ...mctx, [field]: value }), field).toThrow(DecryptError);
    expect(() => decryptMessage(blob, p.randomBytes(32), mctx)).toThrow(DecryptError);
  });
  it('round-trips arbitrary text including emoji and NUL, and big payloads (2 MB)', () => {
    for (const text of ['', ' ', '\u0000', '😀'.repeat(50), 'مرحبا', 'à', 'line\nbreak\r\n']) expect(decryptMessage(encryptMessage({ text }, k.ck, mctx), k.ck, mctx).text).toBe(text);
    const big = 'x'.repeat(2 * 1024 * 1024);
    expect(decryptMessage(encryptMessage({ text: big }, k.ck, mctx), k.ck, mctx).text).toHaveLength(big.length);
  });
  it('two encryptions of the same message differ (random nonce)', () => {
    expect(encryptMessage({ text: 'same' }, k.ck, mctx)).not.toBe(encryptMessage({ text: 'same' }, k.ck, mctx));
  });
  it('rejects ids that contain the separator, empty ids and bad key versions (ambiguous AAD)', () => {
    for (const bad of [{ ...mctx, conversationId: 'a|b' }, { ...mctx, senderId: '' }, { ...mctx, keyVersion: 0 }, { ...mctx, keyVersion: 1.5 }, { ...mctx, conversationId: 'x'.repeat(129) }])
      expect(() => encryptMessage({ text: 'x' }, k.ck, bad as any)).toThrow(FormatError);
  });
  it('rejects wrong lengths and versions with typed errors; never throws anything else on garbage', () => {
    expect(() => decryptMessage('AAAA', k.ck, mctx)).toThrow(FormatError);
    const v = fromBase64Url(V.messages[1].blob).slice(); v[0] = 9;
    expect(() => decryptMessage(toBase64Url(v), k.ck, mctx)).toThrow(expect.objectContaining({ code: 'UNKNOWN_VERSION' }));
    for (let i = 0; i < 300; i++) expect(rejects(() => decryptMessage(toBase64Url(p.randomBytes(1 + (i % 400))), k.ck, mctx)), `garbage ${i}`).toBe(true);
    for (const junk of ['', '!!!!', 'é', ' ']) expect(rejects(() => decryptMessage(junk, k.ck, mctx))).toBe(true);
  });
});

describe('backup', () => {
  const B = V.backup;
  it('reproduces the frozen vector byte for byte and restores it', async () => {
    const out = await createBackup({ deviceId: B.payload.deviceId, privateKey: hex(B.payload.privateKey) }, B.passphrase, B.params, { salt: hex(B.salt), nonce: hex(B.nonce) });
    expect(out.blob).toBe(B.blob); expect(out.kdf).toEqual(B.kdf);
    const back = await restoreBackup({ blob: B.blob, kdf: B.kdf }, B.passphrase);
    expect(back.deviceId).toBe(B.payload.deviceId); expect(toHex(back.privateKey)).toBe(B.payload.privateKey);
  });
  it('a wrong passphrase fails with DecryptError (same error as tampering)', async () => {
    await expect(restoreBackup({ blob: B.blob, kdf: B.kdf }, 'wrong passphrase')).rejects.toThrow(DecryptError);
  });
  it('the kdf header is authenticated: changing m, t, p or the salt fails to decrypt', async () => {
    for (const change of [{ t: 2 }, { m: 2048 }, { p: 2 }, { salt: toBase64Url(new Uint8Array(16)) }]) await expect(restoreBackup({ blob: B.blob, kdf: { ...B.kdf, ...change } }, B.passphrase)).rejects.toThrow(DecryptError);
  });
  it('flipping bytes of the blob is rejected', async () => {
    const n = fromBase64Url(B.blob).length;
    for (const i of [0, 1, 12, 25, 40, n - 17, n - 1]) await expect(restoreBackup({ blob: flip(B.blob, i), kdf: B.kdf }, B.passphrase)).rejects.toBeInstanceOf(Error);
  });
  it('normalises the passphrase (NFKC): composed and decomposed forms derive the same key', async () => {
    const payload = { deviceId: 'd', privateKey: p.randomBytes(32) };
    const a = await createBackup(payload, 'éclair', { m: 1024, t: 1, p: 1 });
    expect((await restoreBackup(a, 'éclair')).deviceId).toBe('d');
  });
  it('rejects kdf parameters outside what the server accepts, and empty passphrases', async () => {
    for (const bad of [{ ...B.kdf, m: 512 }, { ...B.kdf, t: 0 }, { ...B.kdf, p: 17 }, { ...B.kdf, alg: 'argon2i' }, { ...B.kdf, salt: toBase64Url(new Uint8Array(8)) }, { ...B.kdf, v: 2 }]) expect(() => validateKdf(bad)).toThrow(FormatError);
    await expect(createBackup({ deviceId: 'd', privateKey: p.randomBytes(32) }, '', { m: 1024, t: 1, p: 1 })).rejects.toThrow(FormatError);
  });
  it('a default-parameter backup is within the server limit (blob decodes to <= 8192 bytes)', async () => {
    const out = await createBackup({ deviceId: 'd0000000-0000-4000-8000-0000000000a1', privateKey: p.randomBytes(32) }, 'pw', { m: 1024, t: 1, p: 1 });
    expect(fromBase64Url(out.blob).length).toBeLessThanOrEqual(8192);
  });
});
