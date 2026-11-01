import { describe, it, expect } from 'vitest';
import {
  nobleProvider as p, encryptAttachment, decryptAttachment, encryptAttachmentStream, decryptAttachmentStream, ATTACHMENT_CHUNK_SIZE as CH,
  DecryptError, FormatError, toBase64Url, fromBase64Url,
} from '../src/index';
import { toHex, fill, seq } from './helpers';

const META = { name: 'photo.jpg', type: 'image/jpeg', w: 640, h: 480 };
const SEALED = CH + 16;
const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255);
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const enc = (data: Uint8Array) => encryptAttachment(data, META);
const rejects = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { return e instanceof DecryptError || e instanceof FormatError; } return false; };
/** Split a buffer at the given offsets, to feed decryptors input cut anywhere. */
const splitAt = (b: Uint8Array, cuts: number[]) => { const out: Uint8Array[] = []; let last = 0; for (const c of [...cuts, b.length]) { if (c > last) out.push(b.subarray(last, c)); last = Math.max(last, c); } return out; };
async function* feed(parts: Uint8Array[]) { for (const x of parts) { await Promise.resolve(); yield x; } }

describe('attachment round trips', () => {
  const sizes = [0, 1, 2, 63, 64, 65, 1000, CH - 1, CH, CH + 1, 2 * CH - 1, 2 * CH, 2 * CH + 1, 3 * CH + 17, 500_000];
  it.each(sizes)('size %i bytes', async (n) => {
    const data = pattern(n);
    const { ciphertext, descriptor } = await enc(data);
    expect(descriptor.size).toBe(n);
    const chunks = Math.max(1, Math.ceil(n / CH));
    expect(ciphertext.length).toBe(17 + n + 16 * chunks); // header + data + one tag per chunk (an exact multiple of CH has no extra empty chunk)
    expect(ciphertext[0]).toBe(1);
    expect(eq(await decryptAttachment(ciphertext, descriptor), data)).toBe(true);
  });
  it('random sizes up to 1 MB (property test)', async () => {
    for (let i = 0; i < 25; i++) {
      const n = Math.floor((p.randomBytes(4).reduce((a, b) => a * 256 + b, 0) / 2 ** 32) * 1_000_000);
      const data = p.randomBytes(n);
      const { ciphertext, descriptor } = await enc(data);
      expect(eq(await decryptAttachment(ciphertext, descriptor), data), `size ${n}`).toBe(true);
    }
  });
  it('the descriptor carries the real name, type and dimensions; the key is 32 random bytes; two encryptions differ', async () => {
    const a = await enc(pattern(10)), b = await enc(pattern(10));
    expect(a.descriptor).toMatchObject({ v: 1, name: 'photo.jpg', type: 'image/jpeg', w: 640, h: 480, size: 10 });
    expect(fromBase64Url(a.descriptor.key)).toHaveLength(32);
    expect(a.descriptor.key).not.toBe(b.descriptor.key);
    expect(toHex(a.ciphertext)).not.toBe(toHex(b.ciphertext));
  });
  it('the ciphertext contains no plaintext and no file metadata', async () => {
    const marker = new TextEncoder().encode('SECRET-MARKER-SECRET-MARKER');
    const { ciphertext } = await encryptAttachment(marker, { name: 'secret-name.txt', type: 'text/plain' });
    const hay = Buffer.from(ciphertext).toString('latin1');
    expect(hay).not.toContain('SECRET-MARKER'); expect(hay).not.toContain('secret-name'); expect(hay).not.toContain('text/plain');
  });
});

describe('streaming', () => {
  it('encrypting is independent of how the input is split (same key and nonce give the same bytes)', async () => {
    const data = pattern(3 * CH + 999);
    const fixed = { fileKey: seq(32, 1), streamNonce: seq(16, 9) };
    const whole = await encryptAttachment(data, META, fixed);
    for (const cuts of [[1], [CH], [CH - 1, CH + 1], [5, 70000, 70001, 150000], Array.from({ length: 40 }, (_, i) => i * 5000)]) {
      const r = await encryptAttachment(splitAt(data, cuts), META, fixed);
      expect(toHex(r.ciphertext)).toBe(toHex(whole.ciphertext));
    }
  });
  it('decrypting is independent of how the ciphertext is split (every boundary, including 1 byte at a time over a small file)', async () => {
    const data = pattern(2 * CH + 5);
    const { ciphertext, descriptor } = await enc(data);
    for (const cuts of [[1], [16], [17], [18], [SEALED + 17], [SEALED + 17 + 1], [SEALED + 16], [ciphertext.length - 1], Array.from({ length: 30 }, (_, i) => 1 + i * 9000)]) {
      const out: Uint8Array[] = []; for await (const x of decryptAttachmentStream(feed(splitAt(ciphertext, cuts)), descriptor)) out.push(x);
      expect(eq(Uint8Array.from(out.flatMap((x) => [...x])), data), `cuts ${cuts.slice(0, 3)}`).toBe(true);
    }
    const small = await enc(pattern(40));
    const bytes = Array.from({ length: small.ciphertext.length }, (_, i) => small.ciphertext.subarray(i, i + 1));
    expect(eq(await decryptAttachment(feed(bytes), small.descriptor), pattern(40))).toBe(true);
  });
  it('is incremental: the first sealed chunk is produced before the source has been read to the end, and memory stays bounded', async () => {
    let produced = 0; const total = 40 * CH;
    async function* source() { for (let i = 0; i < 40; i++) { produced += CH; yield new Uint8Array(CH).fill(i); } }
    const { chunks } = encryptAttachmentStream(source(), META);
    let seenAtThirdChunk = -1, n = 0;
    for await (const _ of chunks) { n++; if (n === 3) seenAtThirdChunk = produced; }
    expect(seenAtThirdChunk).toBeGreaterThan(0); expect(seenAtThirdChunk).toBeLessThan(total / 4);
  });
  it('handles a 25 MB file end to end without a 25 MB buffer on the encrypt side (checked by streaming a generator)', async () => {
    const total = 25 * 1024 * 1024; let sent = 0;
    async function* source() { while (sent < total) { const n = Math.min(CH * 4, total - sent); sent += n; yield new Uint8Array(n).fill(sent & 255); } }
    const { chunks, descriptor } = encryptAttachmentStream(source(), { name: 'big.bin', type: 'application/octet-stream' });
    const sealed: Uint8Array[] = []; let maxHeld = 0;
    for await (const c of chunks) { sealed.push(c); maxHeld = Math.max(maxHeld, c.length); }
    expect(maxHeld).toBeLessThanOrEqual(SEALED); // never emits more than one sealed chunk at a time
    expect(descriptor().size).toBe(total);
    let got = 0; for await (const x of decryptAttachmentStream(feed(sealed), descriptor())) got += x.length;
    expect(got).toBe(total);
  }, 120_000);
  it('accepts a ReadableStream, an iterable and an async iterable as input', async () => {
    const data = pattern(CH + 10);
    const rs = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data.subarray(0, 100)); c.enqueue(data.subarray(100)); c.close(); } });
    const a = await encryptAttachment(rs, META);
    expect(eq(await decryptAttachment([a.ciphertext.subarray(0, 50), a.ciphertext.subarray(50)], a.descriptor), data)).toBe(true);
    const b = await encryptAttachment(feed([data]), META);
    expect(eq(await decryptAttachment(b.ciphertext, b.descriptor), data)).toBe(true);
    await expect(encryptAttachment(42 as any, META)).rejects.toThrow(FormatError);
  });
  it('descriptor() is not available until the stream has been consumed', async () => {
    const { chunks, descriptor } = encryptAttachmentStream(pattern(10), META);
    expect(() => descriptor()).toThrow();
    for await (const _ of chunks) { /* drain */ }
    expect(descriptor().size).toBe(10);
  });
});

describe('tampering is always detected', () => {
  it('flipping any byte of a one-chunk object is rejected (every position)', async () => {
    const { ciphertext, descriptor } = await enc(pattern(100));
    for (let i = 0; i < ciphertext.length; i++) { const t = ciphertext.slice(); t[i] ^= 1; expect(await rejects(() => decryptAttachment(t, descriptor)), `byte ${i}`).toBe(true); }
  });
  it('flipping bytes across a multi-chunk object is rejected (header, chunk boundaries, tags, last chunk)', async () => {
    const { ciphertext, descriptor } = await enc(pattern(2 * CH + 100));
    const spots = [0, 1, 16, 17, 18, 17 + CH, 17 + CH + 15, 17 + CH + 16, 17 + SEALED + 3, 17 + 2 * SEALED - 1, 17 + 2 * SEALED, ciphertext.length - 17, ciphertext.length - 1];
    for (const i of spots) { const t = ciphertext.slice(); t[i] ^= 0x80; expect(await rejects(() => decryptAttachment(t, descriptor)), `byte ${i}`).toBe(true); }
  });
  it('truncation is detected at every chunk boundary and at arbitrary points', async () => {
    const { ciphertext, descriptor } = await enc(pattern(3 * CH + 50));
    const cuts = [17, 17 + SEALED, 17 + 2 * SEALED, 17 + 3 * SEALED, ciphertext.length - 1, ciphertext.length - 16, ciphertext.length - 17, 18, 5, 0, 1000, 17 + SEALED + 1];
    for (const n of cuts) expect(await rejects(() => decryptAttachment(ciphertext.subarray(0, n), descriptor)), `cut at ${n}`).toBe(true);
  });
  it('truncation to an exact multiple of the chunk size does not pass as a complete file', async () => {
    const { ciphertext, descriptor } = await enc(pattern(2 * CH + 100));
    expect(await rejects(() => decryptAttachment(ciphertext.subarray(0, 17 + 2 * SEALED), descriptor))).toBe(true);
  });
  it('the last-chunk flag alone detects truncation: even with a descriptor size adjusted to match, a cut at a chunk boundary fails', async () => {
    const { ciphertext, descriptor } = await enc(pattern(3 * CH + 50));
    for (const k of [1, 2, 3]) {
      const cut = ciphertext.subarray(0, 17 + k * SEALED);
      await expect(decryptAttachment(cut, { ...descriptor, size: k * CH })).rejects.toThrow(DecryptError);
    }
  });
  it('appending anything (a byte, a chunk, a repeat of the last chunk) is detected', async () => {
    const { ciphertext, descriptor } = await enc(pattern(CH + 7));
    for (const extra of [new Uint8Array([0]), p.randomBytes(16), p.randomBytes(SEALED), ciphertext.subarray(ciphertext.length - 23)]) expect(await rejects(() => decryptAttachment(Uint8Array.from([...ciphertext, ...extra]), descriptor))).toBe(true);
  });
  it('reordering, duplicating and dropping chunks is detected', async () => {
    const { ciphertext, descriptor } = await enc(pattern(3 * CH + 5));
    const head = ciphertext.subarray(0, 17), c = (i: number) => ciphertext.subarray(17 + i * SEALED, 17 + (i + 1) * SEALED), last = ciphertext.subarray(17 + 3 * SEALED);
    const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((x) => [...x]));
    for (const mutated of [join(head, c(1), c(0), c(2), last), join(head, c(0), c(0), c(1), c(2), last), join(head, c(0), c(2), last), join(head, c(1), c(2), last), join(head, c(0), c(1), c(2))])
      expect(await rejects(() => decryptAttachment(mutated, descriptor))).toBe(true);
  });
  it('splicing a chunk from another file with the same key is detected (the stream nonce differs)', async () => {
    const key = seq(32, 5);
    const a = await encryptAttachment(pattern(2 * CH), META, { fileKey: key });
    const b = await encryptAttachment(pattern(2 * CH), META, { fileKey: key });
    const spliced = Uint8Array.from([...a.ciphertext.subarray(0, 17 + SEALED), ...b.ciphertext.subarray(17 + SEALED)]);
    expect(await rejects(() => decryptAttachment(spliced, a.descriptor))).toBe(true);
  });
  it('wrong key, wrong descriptor size, unknown version and short input are typed errors', async () => {
    const { ciphertext, descriptor } = await enc(pattern(CH + 3));
    await expect(decryptAttachment(ciphertext, { ...descriptor, key: toBase64Url(p.randomBytes(32)) })).rejects.toThrow(DecryptError);
    await expect(decryptAttachment(ciphertext, { ...descriptor, size: descriptor.size + 1 })).rejects.toThrow(FormatError);
    const v = ciphertext.slice(); v[0] = 2;
    await expect(decryptAttachment(v, descriptor)).rejects.toThrow(expect.objectContaining({ code: 'UNKNOWN_VERSION' }));
    await expect(decryptAttachment(new Uint8Array(5), descriptor)).rejects.toThrow(FormatError);
    await expect(decryptAttachment(ciphertext, { ...descriptor, key: 'AAAA' })).rejects.toThrow(FormatError);
    await expect(decryptAttachment(ciphertext, { ...descriptor, v: 2 } as any)).rejects.toThrow(FormatError);
  });
  it('random garbage never throws anything but the two typed errors', async () => {
    const { descriptor } = await enc(pattern(10));
    for (let i = 0; i < 100; i++) expect(await rejects(() => decryptAttachment(p.randomBytes(i * 7), descriptor)), `garbage ${i}`).toBe(true);
  });
});

describe('frozen attachment vectors', () => {
  it('reproduce byte for byte (SHA-256 of the whole object; full bytes for the tiny ones) and decrypt', async () => {
    const { readFileSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const V = JSON.parse(readFileSync(new URL('./vectors/vectors.json', import.meta.url), 'utf8')).attachment;
    const hexBytes = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
    for (const c of V.cases) {
      const data = pattern(c.size);
      const { ciphertext, descriptor } = await encryptAttachment(data, META, { fileKey: hexBytes(V.fileKey), streamNonce: hexBytes(V.streamNonce) });
      expect(ciphertext.length, `size ${c.size}`).toBe(c.ciphertextLength);
      expect(createHash('sha256').update(ciphertext).digest('hex'), `size ${c.size}`).toBe(c.ciphertextSha256);
      if (c.ciphertextHex) expect(toHex(ciphertext)).toBe(c.ciphertextHex);
      expect(eq(await decryptAttachment(ciphertext, descriptor), data)).toBe(true);
    }
  });
});
