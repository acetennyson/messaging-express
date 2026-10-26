import { PayloadTooLargeError } from './errors';

/**
 * Reads a JSON request body with a hard size limit, BEFORE anything parses or validates it.
 *
 * Why: validating a body means allocating memory in proportion to its contents (zod keeps one error object per bad
 * array element, for example), and `req.json()` has no limit at all. One authenticated request of a few MB could
 * keep the server busy for seconds and take a gigabyte of memory. Cutting the body off while it is still being
 * read means that cost can never be reached.
 *
 *  - A Content-Length above the limit is refused without reading a single byte.
 *  - Otherwise the body is streamed and counted; the moment it passes the limit the stream is cancelled (this also
 *    covers chunked bodies that declare no length, and clients that lie about it).
 *  - Malformed JSON still throws a SyntaxError (mapped to 400 VALIDATION_ERROR by toErrorResponse), exactly as `req.json()` did.
 */
export const DEFAULT_MAX_JSON_BODY_BYTES = 256 * 1024;

/** MAX_JSON_BODY_BYTES (read on every request), or the default when it is unset or not a positive whole number. */
export function maxJsonBodyBytes(): number {
  const raw = process.env.MAX_JSON_BODY_BYTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_JSON_BODY_BYTES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_JSON_BODY_BYTES;
}

export async function readJsonBody(req: Request, opts: { maxBytes?: number } = {}): Promise<unknown> {
  const max = opts.maxBytes ?? maxJsonBodyBytes();

  const declared = req.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > max) throw new PayloadTooLargeError(max);
  }

  const text = await readTextWithLimit(req, max);
  return JSON.parse(text);
}

async function readTextWithLimit(req: Request, max: number): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError(max);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Decode once, after all chunks are joined: a multi-byte character may be split across two chunks.
  return new TextDecoder('utf-8').decode(bytes);
}
