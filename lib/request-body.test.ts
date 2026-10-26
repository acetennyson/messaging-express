import { afterEach, describe, expect, it } from 'vitest';
import { PayloadTooLargeError } from './errors';
import { DEFAULT_MAX_JSON_BODY_BYTES, maxJsonBodyBytes, readJsonBody } from './request-body';

const enc = new TextEncoder();

/** A POST request whose body is the given chunks, delivered one per read. `pulled` counts how many were read. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks.length) return controller.close();
      controller.enqueue(chunks[state.pulled++]);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const req = new Request('http://localhost/x', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
  return { req, state };
}
const plain = (text: string, headers: Record<string, string> = {}) =>
  new Request('http://localhost/x', { method: 'POST', body: text, headers });

afterEach(() => {
  delete process.env.MAX_JSON_BODY_BYTES;
});

describe('readJsonBody', () => {
  it('parses a normal JSON body', async () => {
    expect(await readJsonBody(plain('{"a":[1,2,3],"b":"ü"}'))).toEqual({ a: [1, 2, 3], b: 'ü' });
  });

  it('accepts a body of exactly the limit and refuses one byte more', async () => {
    const json = '{"k":"' + 'x'.repeat(90) + '"}'; // some known length
    const n = enc.encode(json).byteLength;
    expect(await readJsonBody(plain(json), { maxBytes: n })).toEqual({ k: 'x'.repeat(90) });
    await expect(readJsonBody(plain(json), { maxBytes: n - 1 })).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('refuses a declared Content-Length over the limit WITHOUT reading the body', async () => {
    const { req, state } = streamed([enc.encode('{}')], { 'content-length': '999999' });
    await expect(readJsonBody(req, { maxBytes: 1000 })).rejects.toBeInstanceOf(PayloadTooLargeError);
    // (a ReadableStream pre-fetches one chunk by itself, so "pulled" is not the right measure: the body must be untouched)
    expect(req.bodyUsed).toBe(false);
    expect(state.cancelled).toBe(false);
  });

  it('counts a chunked body that declares no length, and cancels the stream as soon as the limit is passed', async () => {
    const chunk = enc.encode('1,'.repeat(50)); // 100 bytes
    const chunks = Array.from({ length: 1000 }, () => chunk); // 100 kB in total
    const { req, state } = streamed(chunks);
    await expect(readJsonBody(req, { maxBytes: 450 })).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(10); // it stopped early: nowhere near all 1000 chunks were read
  });

  it('is not fooled by a Content-Length that understates the real size', async () => {
    const chunk = enc.encode('x'.repeat(100));
    const { req } = streamed([chunk, chunk, chunk], { 'content-length': '10' });
    await expect(readJsonBody(req, { maxBytes: 150 })).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('decodes a multi-byte character that is split across two chunks', async () => {
    const bytes = enc.encode('{"emoji":"€"}'); // "€" is 3 bytes in UTF-8
    const cut = bytes.indexOf(0xe2) + 1; // split inside the character
    const { req } = streamed([bytes.slice(0, cut), bytes.slice(cut)]);
    expect(await readJsonBody(req, { maxBytes: 100 })).toEqual({ emoji: '€' });
  });

  it('still throws a SyntaxError for malformed or empty JSON (mapped to 400 as before)', async () => {
    await expect(readJsonBody(plain('{"a":'))).rejects.toBeInstanceOf(SyntaxError);
    await expect(readJsonBody(new Request('http://localhost/x', { method: 'POST' }))).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe('maxJsonBodyBytes', () => {
  it('defaults to 256 KiB', () => {
    expect(DEFAULT_MAX_JSON_BODY_BYTES).toBe(262144);
    expect(maxJsonBodyBytes()).toBe(262144);
  });

  it('is overridden by MAX_JSON_BODY_BYTES and read at request time', async () => {
    process.env.MAX_JSON_BODY_BYTES = '20';
    expect(maxJsonBodyBytes()).toBe(20);
    await expect(readJsonBody(plain('{"a":"' + 'x'.repeat(30) + '"}'))).rejects.toBeInstanceOf(PayloadTooLargeError);
    process.env.MAX_JSON_BODY_BYTES = '5000';
    expect(await readJsonBody(plain('{"a":"' + 'x'.repeat(30) + '"}'))).toEqual({ a: 'x'.repeat(30) });
  });

  it('falls back to the default for values that are not a positive whole number', () => {
    for (const bad of ['abc', '0', '-5', '1.5', '', '  ']) {
      process.env.MAX_JSON_BODY_BYTES = bad;
      expect(maxJsonBodyBytes(), `"${bad}"`).toBe(DEFAULT_MAX_JSON_BODY_BYTES);
    }
  });

  it('an explicit maxBytes option beats the environment', async () => {
    process.env.MAX_JSON_BODY_BYTES = '10';
    expect(await readJsonBody(plain('{"a":"' + 'x'.repeat(30) + '"}'), { maxBytes: 1000 })).toEqual({ a: 'x'.repeat(30) });
  });
});
