import { afterEach, describe, expect, it } from 'vitest';
import { createClient, MessagingExpressError } from '../src';
import { json, startMockServer } from './mockServer';

const png = (name: string, size = 10) => new File([new Uint8Array(size)], name, { type: 'image/png' });
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** API + storage on one mock server. `presign` decides what /presign answers. */
async function setup(opts: {
  presign?: (n: number, body: any) => { status: number; body: unknown; headers?: Record<string, string> };
  proxy?: (n: number, filename: string) => { status: number; body: unknown };
  storage?: (n: number) => number;
  delayMs?: number;
}) {
  let presignN = 0, proxyN = 0, storageN = 0, inFlight = 0, maxInFlight = 0;
  const server = await startMockServer(async (req, res) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (req.url === '/api/v1/uploads/presign') {
        const body = JSON.parse(req.body.toString());
        const r = opts.presign!(presignN++, body);
        return json(res, r.status, r.body, r.headers);
      }
      if (req.url === '/api/v1/uploads') {
        const m = /filename="([^"]+)"/.exec(req.body.toString('latin1'));
        const r = opts.proxy!(proxyN++, m?.[1] ?? '');
        return json(res, r.status, r.body);
      }
      if (req.url!.startsWith('/storage/')) {
        const n = storageN++;
        res.writeHead(opts.storage ? opts.storage(n) : 200).end();
        return;
      }
      res.writeHead(404).end();
    } finally {
      inFlight--;
    }
  });
  closers.push(server.close);
  const presignOk = (filename: string) => ({
    status: 200,
    body: { data: { uploadUrl: `${server.url}/storage/${filename}`, publicUrl: `https://cdn.test/${filename}`, method: 'PUT', headers: { 'Content-Type': 'image/png' }, type: 'image', filename, mimeType: 'image/png', sizeBytes: 10 } },
  });
  return { server, presignOk, stats: () => ({ presignN, proxyN, storageN, maxInFlight }) };
}

describe('uploads: presign first, fall back to the API', () => {
  it('uses the presigned URL and returns an attachment', async () => {
    const { server, presignOk, stats } = await setup({ presign: (_n, b) => presignOk(b.filename) });
    const client = createClient({ baseUrl: server.url, token: 't' });
    const out = await client.uploads.uploadOne(png('a.png'));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.attachment).toMatchObject({ type: 'image', url: 'https://cdn.test/a.png', filename: 'a.png', mimeType: 'image/png' });
    expect(stats()).toMatchObject({ presignN: 1, storageN: 1, proxyN: 0 });
    const put = server.requests.find((r) => r.url.startsWith('/storage/'))!;
    expect(put.method).toBe('PUT');
    expect(put.headers.authorization).toBeUndefined(); // the API token must never be sent to storage
  });

  it('501 from presign falls back to POST /uploads, and stops asking presign for the rest of the batch', async () => {
    const { server, stats } = await setup({
      presign: () => ({ status: 501, body: { error: { message: 'no', code: 'PRESIGN_NOT_SUPPORTED' } } }),
      proxy: (_n, filename) => ({ status: 200, body: { data: [{ type: 'image', url: `http://x/${filename}`, filename, mimeType: 'image/png', sizeBytes: 10 }] } }),
    });
    const client = createClient({ baseUrl: server.url, token: 't' });
    const out = await client.uploads.upload([png('a.png'), png('b.png'), png('c.png')], { concurrency: 1 });
    expect(out.every((o) => o.ok)).toBe(true);
    expect(stats().proxyN).toBe(3);
    expect(stats().presignN).toBe(1); // asked once, then remembered
  });

  it('direct: "never" skips presign entirely', async () => {
    const { server, stats } = await setup({
      presign: () => { throw new Error('should not be called'); },
      proxy: (_n, filename) => ({ status: 200, body: { data: [{ type: 'image', url: 'http://x/a', filename, mimeType: 'image/png', sizeBytes: 1 }] } }),
    });
    const out = await createClient({ baseUrl: server.url, token: 't' }).uploads.uploadOne(png('a.png'), { direct: 'never' });
    expect(out.ok).toBe(true);
    expect(stats().presignN).toBe(0);
  });

  it('one failing file does not fail the batch; results keep input order', async () => {
    const { server, presignOk } = await setup({
      presign: (_n, b) => (b.filename === 'c.png'
        ? { status: 400, body: { error: { message: 'File type not allowed: image/png', code: 'VALIDATION_ERROR' } } }
        : presignOk(b.filename)),
      delayMs: 5,
    });
    const files = ['a', 'b', 'c', 'd', 'e'].map((n) => png(`${n}.png`));
    const done: number[] = [];
    const out = await createClient({ baseUrl: server.url, token: 't' }).uploads.upload(files, {
      concurrency: 3,
      onFileDone: (i) => done.push(i),
    });
    expect(out.map((o) => o.ok)).toEqual([true, true, false, true, true]);
    expect(out.map((o) => (o.file as File).name)).toEqual(['a.png', 'b.png', 'c.png', 'd.png', 'e.png']);
    const bad = out[2];
    if (!bad.ok) { expect(bad.error).toMatch(/not allowed/); expect(bad.code).toBe('VALIDATION_ERROR'); }
    expect(done.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('never runs more uploads at once than `concurrency`', async () => {
    const { server, presignOk, stats } = await setup({ presign: (_n, b) => presignOk(b.filename), delayMs: 30 });
    const files = Array.from({ length: 9 }, (_, i) => png(`f${i}.png`));
    await createClient({ baseUrl: server.url, token: 't' }).uploads.upload(files, { concurrency: 2 });
    expect(stats().maxInFlight).toBeLessThanOrEqual(2);
    expect(stats().maxInFlight).toBeGreaterThan(0);
  });

  it('storage rejecting the PUT is reported for that file', async () => {
    const { server, presignOk } = await setup({ presign: (_n, b) => presignOk(b.filename), storage: () => 403 });
    const out = await createClient({ baseUrl: server.url, token: 't' }).uploads.uploadOne(png('a.png'));
    expect(out.ok).toBe(false);
    if (!out.ok) { expect(out.code).toBe('STORAGE_REJECTED'); expect(out.error).toMatch(/403/); }
  });

  it('a proxy 503 is NOT retried (a repeated POST could store the file twice)', async () => {
    const { server, stats } = await setup({
      presign: () => ({ status: 501, body: { error: { message: 'no', code: 'PRESIGN_NOT_SUPPORTED' } } }),
      proxy: () => ({ status: 503, body: { error: { message: 'busy', code: 'UNAVAILABLE' } } }),
    });
    const out = await createClient({ baseUrl: server.url, token: 't' }).uploads.uploadOne(png('a.png'));
    expect(out.ok).toBe(false);
    expect(stats().proxyN).toBe(1);
  });

  it('proxy per-file error entries are surfaced', async () => {
    const { server } = await setup({
      presign: () => ({ status: 501, body: { error: { message: 'no', code: 'PRESIGN_NOT_SUPPORTED' } } }),
      proxy: () => ({ status: 200, body: { data: [{ filename: 'a.png', error: 'File type not allowed' }] } }),
    });
    const out = await createClient({ baseUrl: server.url, token: 't' }).uploads.uploadOne(png('a.png'));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('File type not allowed');
  });

  it('reports progress 100 for a finished file', async () => {
    const { server, presignOk } = await setup({ presign: (_n, b) => presignOk(b.filename) });
    const seen: Array<[number, number]> = [];
    await createClient({ baseUrl: server.url, token: 't' }).uploads.upload([png('a.png')], { onProgress: (i, p) => seen.push([i, p]) });
    expect(seen.at(-1)).toEqual([0, 100]);
  });

  it('sends the category to presign and the Authorization header (token function awaited per request)', async () => {
    let calls = 0;
    const { server, presignOk } = await setup({ presign: (_n, b) => { expect(b.category).toBe('avatars'); return presignOk(b.filename); } });
    const client = createClient({ baseUrl: server.url, token: async () => `tok-${++calls}` });
    await client.uploads.upload([png('a.png'), png('b.png')], { category: 'avatars', concurrency: 1 });
    const auths = server.requests.filter((r) => r.url.endsWith('/presign')).map((r) => r.headers.authorization);
    expect(auths).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });
});

describe('createClient validation', () => {
  it('requires a token and (outside a browser) a baseUrl', () => {
    expect(() => createClient({ baseUrl: 'http://x', token: '' })).toThrow(/token/);
    expect(() => createClient({ token: 't' })).toThrow(/baseUrl/);
  });
  it('exposes a typed error class', () => {
    expect(new MessagingExpressError('x', { status: 1, code: 'C' })).toBeInstanceOf(Error);
  });
});
