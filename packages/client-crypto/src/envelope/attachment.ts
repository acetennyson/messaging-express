import { nobleProvider } from '../crypto/noble';
import type { CryptoProvider } from '../crypto/provider';
import { fromBase64Url, toBase64Url } from '../format/base64url';
import { FormatError, DecryptError } from '../format/errors';
import { KEY_LENGTH, TAG_LENGTH, VERSION, concat, requireBytes, utf8, zeroize } from '../format/context';

/** Plaintext bytes per chunk. Part of the frozen format (WIRE_FORMAT.md). */
export const ATTACHMENT_CHUNK_SIZE = 65536;
const STREAM_NONCE_LENGTH = 16;
const HEADER_LENGTH = 1 + STREAM_NONCE_LENGTH;
const SEALED_CHUNK = ATTACHMENT_CHUNK_SIZE + TAG_LENGTH;
const AAD = utf8('mx-e2ee-v1|att');
const MAX_CHUNKS = 2 ** 32; // the counter is a uint32

/** Where the file's secrets and facts live: INSIDE the encrypted message payload, never on the server. */
export interface AttachmentDescriptor {
  v: 1;
  /** base64url 32-byte file key (random, one per attachment). */
  key: string;
  /** Plaintext size in bytes. */
  size: number;
  name: string;
  /** The real MIME type. The uploaded object itself is opaque application/octet-stream. */
  type: string;
  w?: number;
  h?: number;
}
export type AttachmentMeta = Pick<AttachmentDescriptor, 'name' | 'type' | 'w' | 'h'>;
export type ByteSource = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
export interface AttachmentOptions {
  provider?: CryptoProvider;
  /** TESTS ONLY: fixed key and stream nonce, to produce reproducible vectors. */
  fileKey?: Uint8Array;
  streamNonce?: Uint8Array;
}

export function parseAttachmentDescriptor(d: unknown): AttachmentDescriptor {
  const x = d as Partial<AttachmentDescriptor> | null;
  if (!x || x.v !== 1 || typeof x.key !== 'string' || typeof x.name !== 'string' || typeof x.type !== 'string' || typeof x.size !== 'number' || !Number.isSafeInteger(x.size) || x.size < 0) throw new FormatError('BAD_PAYLOAD', 'invalid attachment descriptor');
  if (fromBase64Url(x.key).length !== KEY_LENGTH) throw new FormatError('BAD_PAYLOAD', 'attachment key must be 32 bytes');
  for (const k of ['w', 'h'] as const) if (x[k] !== undefined && (!Number.isSafeInteger(x[k]) || (x[k] as number) < 0)) throw new FormatError('BAD_PAYLOAD', `invalid attachment ${k}`);
  return x as AttachmentDescriptor;
}

async function* chunksOf(source: ByteSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) { yield source; return; }
  if (typeof (source as any)?.[Symbol.asyncIterator] === 'function') { for await (const p of source as AsyncIterable<Uint8Array>) yield p; return; }
  if (typeof (source as any)?.getReader === 'function') {
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    try { for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; } } finally { reader.releaseLock(); }
    return;
  }
  if (typeof (source as any)?.[Symbol.iterator] === 'function') { for (const p of source as Iterable<Uint8Array>) yield p; return; }
  throw new FormatError('BAD_INPUT', 'source must be a Uint8Array, an iterable or async iterable of Uint8Array, or a ReadableStream');
}

function chunkNonce(streamNonce: Uint8Array, index: number, last: boolean): Uint8Array {
  const n = new Uint8Array(24);
  n.set(streamNonce, 0);
  new DataView(n.buffer).setUint32(STREAM_NONCE_LENGTH, index, false);
  n[STREAM_NONCE_LENGTH + 4] = last ? 1 : 0;
  return n;
}

/**
 * Encrypts a file as it is read: memory use is a few chunks (about 200 KiB) whatever the file size. Yields the header first, then one sealed chunk at a time.
 * `descriptor()` is available once the generator has finished.
 */
export function encryptAttachmentStream(source: ByteSource, meta: AttachmentMeta, opts: AttachmentOptions = {}): { chunks: AsyncGenerator<Uint8Array>; descriptor: () => AttachmentDescriptor } {
  const c = opts.provider ?? nobleProvider;
  const fileKey = opts.fileKey ?? c.randomBytes(KEY_LENGTH);
  const streamNonce = opts.streamNonce ?? c.randomBytes(STREAM_NONCE_LENGTH);
  requireBytes('fileKey', fileKey, KEY_LENGTH);
  requireBytes('streamNonce', streamNonce, STREAM_NONCE_LENGTH);
  let size = 0;
  let finished = false;

  async function* run(): AsyncGenerator<Uint8Array> {
    let index = 0;
    const seal = (plain: Uint8Array, last: boolean): Uint8Array => {
      if (index >= MAX_CHUNKS) throw new FormatError('BAD_INPUT', 'attachment too large (more than 2^32 chunks)');
      return c.aeadEncrypt(fileKey, chunkNonce(streamNonce, index++, last), plain, AAD);
    };
    yield concat(new Uint8Array([VERSION]), streamNonce);
    let cur = new Uint8Array(ATTACHMENT_CHUNK_SIZE);
    let fill = 0;
    let held: Uint8Array | null = null; // a full chunk waits until we know whether more data follows (the last chunk is flagged)
    for await (const piece of chunksOf(source)) {
      requireBytes('source piece', piece);
      size += piece.length;
      for (let off = 0; off < piece.length; ) {
        const n = Math.min(ATTACHMENT_CHUNK_SIZE - fill, piece.length - off);
        cur.set(piece.subarray(off, off + n), fill);
        fill += n; off += n;
        if (fill === ATTACHMENT_CHUNK_SIZE) {
          if (held) yield seal(held, false);
          held = cur; cur = new Uint8Array(ATTACHMENT_CHUNK_SIZE); fill = 0;
        }
      }
    }
    if (held && fill === 0) yield seal(held, true);
    else { if (held) yield seal(held, false); yield seal(cur.subarray(0, fill), true); } // also covers the empty file: one empty, flagged chunk
    finished = true;
  }

  return {
    chunks: run(),
    descriptor() {
      if (!finished) throw new Error('descriptor() is only available after the chunk stream has been fully consumed');
      return { v: 1, key: toBase64Url(fileKey), size, name: meta.name, type: meta.type, ...(meta.w !== undefined ? { w: meta.w } : {}), ...(meta.h !== undefined ? { h: meta.h } : {}) };
    },
  };
}

class ByteQueue {
  private parts: Uint8Array[] = [];
  length = 0;
  push(p: Uint8Array) { if (p.length) { this.parts.push(p); this.length += p.length; } }
  take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const p = this.parts[0];
      const k = Math.min(p.length, n - o);
      out.set(p.subarray(0, k), o);
      o += k;
      if (k === p.length) this.parts.shift(); else this.parts[0] = p.subarray(k);
    }
    this.length -= n;
    return out;
  }
}

/**
 * Decrypts as it reads. Input may be split anywhere. Throws FormatError for a malformed object and DecryptError if a chunk does not authenticate,
 * which is what truncation, reordering, appending and any modification all produce. Plaintext already yielded was authenticated chunk by chunk,
 * but only after the generator completes without error is the WHOLE file known to be complete and intact: do not treat partial output as final.
 */
export async function* decryptAttachmentStream(source: ByteSource, descriptor: AttachmentDescriptor, opts: { provider?: CryptoProvider } = {}): AsyncGenerator<Uint8Array> {
  const c = opts.provider ?? nobleProvider;
  const d = parseAttachmentDescriptor(descriptor);
  const fileKey = fromBase64Url(d.key);
  const q = new ByteQueue();
  const it = chunksOf(source)[Symbol.asyncIterator]();
  let ended = false;
  const fill = async (need: number) => { while (!ended && q.length < need) { const r = await it.next(); if (r.done) ended = true; else q.push(requireBytes('source piece', r.value)); } };
  try {
    await fill(HEADER_LENGTH);
    if (q.length < HEADER_LENGTH) throw new FormatError('BAD_LENGTH', 'attachment is shorter than its header');
    const header = q.take(HEADER_LENGTH);
    if (header[0] !== VERSION) throw new FormatError('UNKNOWN_VERSION', `unknown attachment version ${header[0]}`);
    const streamNonce = header.subarray(1);
    let index = 0, total = 0;
    for (;;) {
      await fill(SEALED_CHUNK + 1); // one byte of lookahead tells us whether this chunk is the last
      if (q.length > SEALED_CHUNK) {
        const plain = c.aeadDecrypt(fileKey, chunkNonce(streamNonce, index++, false), q.take(SEALED_CHUNK), AAD);
        total += plain.length; yield plain;
      } else {
        if (q.length < TAG_LENGTH) throw new FormatError('BAD_LENGTH', 'attachment is truncated');
        const plain = c.aeadDecrypt(fileKey, chunkNonce(streamNonce, index++, true), q.take(q.length), AAD);
        total += plain.length;
        if (total !== d.size) throw new FormatError('BAD_PAYLOAD', `attachment is ${total} bytes but its descriptor says ${d.size}`);
        yield plain;
        return;
      }
    }
  } finally {
    zeroize(fileKey);
    await it.return?.(undefined);
  }
}

async function collect(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of gen) parts.push(p);
  return concat(...parts);
}

/** Whole-file convenience: encrypt a Uint8Array (or any ByteSource) into one Uint8Array. For big files use `encryptAttachmentStream`. */
export async function encryptAttachment(bytes: ByteSource, meta: AttachmentMeta, opts: AttachmentOptions = {}): Promise<{ ciphertext: Uint8Array; descriptor: AttachmentDescriptor }> {
  const { chunks, descriptor } = encryptAttachmentStream(bytes, meta, opts);
  const ciphertext = await collect(chunks);
  return { ciphertext, descriptor: descriptor() };
}
export async function decryptAttachment(ciphertext: ByteSource, descriptor: AttachmentDescriptor, opts: { provider?: CryptoProvider } = {}): Promise<Uint8Array> {
  return collect(decryptAttachmentStream(ciphertext, descriptor, opts));
}
