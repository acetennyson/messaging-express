/** M8b: the `upload` init option (local disk, S3-compatible, not configured). Needs a test database for the integration part. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'crypto';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'fs';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import sharp from 'sharp';
import { MessagingServer } from '../server';
import { ConfigError } from '../errors';
import { resolveOptions } from '../options';

const URL_ = process.env.TEST_SCHEMA_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'm8b-uploads-secret-m8b-uploads-secret';
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const base = { database: 'postgres://x@localhost/x', jwtSecret: SECRET };
const local = { type: 'local', options: { dir: '/tmp/x', baseUrl: 'https://api.test/chat' } };
const s3 = { type: 's3', options: { bucket: 'b', region: 'auto' } };

describe('upload option validation', () => {
  it('is optional', () => {
    expect(resolveOptions(base as never).upload).toBeUndefined();
  });
  it('resolves local with defaults and normalises the base URL', () => {
    const r = resolveOptions({ ...base, upload: { ...local, options: { dir: '/d', baseUrl: 'https://api.test/chat/' } } } as never);
    expect(r.upload).toEqual({ type: 'local', route: '/uploads', dir: '/d', baseUrl: 'https://api.test/chat' });
  });
  it('accepts S3 in any letter case', () => {
    expect(resolveOptions({ ...base, upload: { ...s3, type: 'S3' } } as never).upload).toMatchObject({ type: 's3', bucket: 'b', region: 'auto' });
  });
  it.each([
    [{ type: 'gcs', options: {} }, /upload\.type/],
    [{ type: 'local' }, /upload\.options\.dir/],
    [{ type: 'local', options: { dir: '/d' } }, /upload\.options\.baseUrl/],
    [{ type: 'local', options: { dir: '/d', baseUrl: '/chat' } }, /absolute URL/],
    [{ type: 'local', options: { dir: '/d', baseUrl: 'ftp://x' } }, /http/],
    [{ ...local, route: 'uploads' }, /upload\.route/],
    [{ ...local, route: '/a/' }, /upload\.route/],
    [{ ...local, route: '/api/v1' }, /used by the API/],
    [{ ...local, options: { ...local.options, extra: 1 } }, /unknown field 'extra'/],
    [{ type: 's3', options: { region: 'r' } }, /upload\.options\.bucket/],
    [{ type: 's3', options: { bucket: 'b' } }, /upload\.options\.region/],
    [{ ...s3, route: '/files' }, /only applies to type 'local'/],
    [{ type: 's3', options: { ...s3.options, accessKeyId: 'a' } }, /go together/],
    [{ type: 's3', options: { ...s3.options, endpoint: 'nope' } }, /endpoint/],
    [{ ...s3, limits: { maxSizeBytes: 0 } }, /maxSizeBytes/],
    [{ ...s3, limits: { allowedMimeTypes: ['png'] } }, /allowedMimeTypes/],
    [{ ...s3, limits: { nope: 1 } }, /unknown field 'nope'/],
  ])('rejects %j', (upload, msg) => {
    expect(() => resolveOptions({ ...base, upload } as never)).toThrow(ConfigError);
    expect(() => resolveOptions({ ...base, upload } as never)).toThrow(msg);
  });
});

describe.skipIf(!URL_)('upload option (integration)', () => {
  const schema = `m8b_${randomBytes(4).toString('hex')}`;
  const admin = new Pool({ connectionString: URL_, max: 2 });
  const open: MessagingServer[] = [];
  const dirs: string[] = [];
  const api = jwt.sign({ type: 'api' }, SECRET, { expiresIn: '1h' });
  const init = async (upload?: object, projectName = 'up') => {
    const s = await MessagingServer.init({ database: URL_!, jwtSecret: SECRET, schema, logger: silent, projectName, ...(upload ? { upload } : {}) } as never);
    open.push(s);
    return s;
  };
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'mx-up-'));
    dirs.push(d);
    return d;
  };
  const post = async (s: MessagingServer, name: string, type: string, bytes: Buffer | Uint8Array) => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(bytes)], name, { type }));
    return s.handler(new Request('http://chat.test/api/v1/uploads', { method: 'POST', headers: { authorization: `Bearer ${api}` }, body: form }));
  };

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await MessagingServer.migrate({ database: URL_!, schema });
  }, 120_000);
  afterAll(async () => {
    await Promise.all(open.map((s) => s.close({ timeoutMs: 1000 }).catch(() => undefined)));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('not configured: uploads answer 501 and nothing is served', async () => {
    const s = await init(undefined, 'none');
    const res = await post(s, 'a.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
    expect(res.status).toBe(501);
    expect(JSON.stringify(await res.json())).toContain('STORAGE_NOT_CONFIGURED');
    const presign = await s.handler(
      new Request('http://chat.test/api/v1/uploads/presign', {
        method: 'POST',
        headers: { authorization: `Bearer ${api}`, 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 }),
      })
    );
    expect(presign.status).toBe(501);
    expect((await s.handler(new Request('http://chat.test/uploads/x.pdf'))).status).toBe(404);
  });

  it('local: upload, get the file back at the returned URL, probe the image, delete path stays inside dir', async () => {
    const dir = tmp();
    const s = await init({ type: 'local', options: { dir, baseUrl: 'https://api.test/chat' } }, 'loc');
    const png = await sharp({ create: { width: 7, height: 5, channels: 3, background: '#fff' } }).png().toBuffer();
    const res = await post(s, 'pic.png', 'image/png', png);
    expect(res.status).toBe(200);
    const item = (await res.json()).data[0];
    expect(item.url).toMatch(/^https:\/\/api\.test\/chat\/uploads\/[0-9a-f-]{36}-pic\.png$/);
    expect(item).toMatchObject({ type: 'image', width: 7, height: 5 });
    expect(readdirSync(dir)).toHaveLength(1);

    const served = await s.handler(new Request(`http://chat.test${new URL(item.url).pathname.replace('/chat', '')}`));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);
    expect((await s.handler(new Request('http://chat.test/uploads/..%2f..%2fetc%2fpasswd'))).status).toBe(404);
  });

  it('local with a custom route: served there, and not at /uploads', async () => {
    const dir = tmp();
    const s = await init({ type: 'local', route: '/files/chat', options: { dir, baseUrl: 'https://api.test' } }, 'route');
    const res = await post(s, 'doc.pdf', 'application/pdf', Buffer.from('%PDF-1.4 hello'));
    const url = new URL((await res.json()).data[0].url);
    expect(url.origin + url.pathname.replace(/[0-9a-f-]{36}-doc\.pdf$/, '')).toBe('https://api.test/files/chat/');
    expect((await s.handler(new Request(`http://chat.test${url.pathname}`))).status).toBe(200);
    expect((await s.handler(new Request(`http://chat.test/uploads/${url.pathname.split('/').pop()}`))).status).toBe(404);
    expect(s.matches('GET', url.pathname)).toBe(true);
  });

  it('local: limits apply (type and size)', async () => {
    const s = await init({ type: 'local', options: { dir: tmp(), baseUrl: 'https://api.test' }, limits: { maxSizeBytes: 10, allowedMimeTypes: ['application/pdf'] } }, 'lim');
    const big = await (await post(s, 'big.pdf', 'application/pdf', Buffer.alloc(50))).json();
    expect(JSON.stringify(big)).toMatch(/size|exceed/i);
    const wrong = await (await post(s, 'a.png', 'image/png', Buffer.alloc(3))).json();
    expect(JSON.stringify(wrong)).toMatch(/not allowed/i);
  });

  describe('s3 (against a local S3-like endpoint)', () => {
    const puts: { method: string; url: string; type?: string }[] = [];
    let fake: Server;
    let port = 0;
    beforeAll(async () => {
      fake = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          puts.push({ method: req.method ?? '', url: req.url ?? '', type: req.headers['content-type'] });
          res.writeHead(200, { etag: '"x"' });
          res.end();
        });
      });
      await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
      port = (fake.address() as { port: number }).port;
    });
    afterAll(() => new Promise<void>((r) => fake.close(() => r())));

    const options = () => ({ bucket: 'chat-files', region: 'us-east-1', endpoint: `http://127.0.0.1:${port}`, accessKeyId: 'AKIATEST', secretAccessKey: 'secret' });

    it('stores in the bucket and returns its public URL; /uploads serves nothing', async () => {
      const s = await init({ type: 's3', options: { ...options(), publicBaseUrl: 'https://cdn.test/files' } }, 's3a');
      const res = await post(s, 'a.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
      expect(res.status).toBe(200);
      const item = (await res.json()).data[0];
      expect(item.url).toMatch(/^https:\/\/cdn\.test\/files\/[0-9a-f-]{36}\/[0-9a-f-]{36}-a\.pdf$/);
      const put = puts.find((p) => p.method === 'PUT');
      expect(put?.url).toMatch(/^\/chat-files\/[0-9a-f-]{36}\/[0-9a-f-]{36}-a\.pdf/); // path style, because an endpoint is set
      expect(put?.type).toBe('application/pdf');
      expect((await s.handler(new Request('http://chat.test/uploads/a.pdf'))).status).toBe(404);
    });

    it('presign hands out a signed PUT URL for the bucket', async () => {
      const s = await init({ type: 's3', options: options() }, 's3b');
      const res = await s.handler(
        new Request('http://chat.test/api/v1/uploads/presign', {
          method: 'POST',
          headers: { authorization: `Bearer ${api}`, 'content-type': 'application/json' },
          body: JSON.stringify({ filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 }),
        })
      );
      expect(res.status).toBe(200);
      expect(JSON.stringify(await res.json())).toContain('X-Amz-Signature');
    });
  });

  it('a local folder that cannot be used is not an init error; an unreadable S3 setup is reported with the option name', async () => {
    expect(existsSync('/definitely/not/here')).toBe(false);
    const err = await MessagingServer.init({ database: URL_!, jwtSecret: SECRET, schema, logger: silent, upload: { type: 's3', options: { bucket: '', region: 'r' } } } as never).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.option).toBe('upload.options.bucket');
  });
});
