import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createRequire } from 'module';
import { createNodeHandler, normalizeRoot, type WebHandler } from './node';

const require_ = createRequire(__filename);
const express4 = require_('express4');
const express5 = require_('express5');

/** A stand-in for MessagingServer: knows two routes, echoes what it was given. */
const fake: WebHandler & { last?: Request } = {
  matches: (method, pathname) => pathname.startsWith('/api/v1/') || (method === 'GET' && pathname === '/meta'),
  async handler(request) {
    fake.last = request;
    const url = new URL(request.url);
    if (url.pathname === '/api/v1/boom') throw new Error('secret stack detail');
    if (url.pathname === '/api/v1/cookies') {
      const h = new Headers({ 'content-type': 'text/plain' });
      h.append('set-cookie', 'a=1; Path=/');
      h.append('set-cookie', 'b=2; Path=/');
      return new Response('ok', { status: 201, headers: h });
    }
    if (url.pathname === '/api/v1/stream') {
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(c) {
            for (const part of ['one,', 'two,', 'three']) {
              c.enqueue(enc.encode(part));
              await new Promise((r) => setTimeout(r, 5));
            }
            c.close();
          },
        })
      );
    }
    const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    return Response.json({ method: request.method, path: url.pathname, search: url.search, type: request.headers.get('content-type'), body: text });
  },
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const plain = (opts = {}) => listen(http.createServer(createNodeHandler(fake, opts)));

describe('plain http.createServer', () => {
  it('routes a JSON POST: method, path, query, headers and the streamed body arrive intact', async () => {
    const base = await plain();
    const r = await fetch(`${base}/api/v1/users?limit=2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'é€' }) });
    expect(await r.json()).toEqual({ method: 'POST', path: '/api/v1/users', search: '?limit=2', type: 'application/json', body: '{"a":"é€"}' });
  });

  it('strips a root prefix; paths outside it are a 404 (or next())', async () => {
    const base = await plain({ root: '/chat' });
    expect((await (await fetch(`${base}/chat/api/v1/x`)).json()).path).toBe('/api/v1/x');
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect((await fetch(`${base}/chatter/api/v1/x`)).status).toBe(404); // not a path-segment match
    expect((await fetch(`${base}/chat/nope`)).status).toBe(404);
  });

  it('copies status, headers and every Set-Cookie as its own header', async () => {
    const base = await plain();
    const r = await fetch(`${base}/api/v1/cookies`);
    expect(r.status).toBe(201);
    expect(r.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(r.headers.get('content-type')).toBe('text/plain');
  });

  it('streams a response body and answers HEAD without one', async () => {
    const base = await plain();
    expect(await (await fetch(`${base}/api/v1/stream`)).text()).toBe('one,two,three');
    const head = await fetch(`${base}/api/v1/stream`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('a throwing handler gives a generic 500: no message, no stack', async () => {
    const seen: unknown[] = [];
    const base = await listen(http.createServer(createNodeHandler(fake, {}, (e) => seen.push(e))));
    const r = await fetch(`${base}/api/v1/boom`);
    const text = await r.text();
    expect(r.status).toBe(500);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('at ');
    expect(seen).toHaveLength(1); // logged server side
  });

  it('a large streamed upload reaches the handler whole', async () => {
    const base = await plain();
    const big = 'x'.repeat(3_000_000);
    const r = await fetch(`${base}/api/v1/up`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: big });
    expect((await r.json()).body.length).toBe(big.length);
  });

  it('normalizeRoot', () => {
    expect([normalizeRoot(undefined), normalizeRoot('/'), normalizeRoot('chat'), normalizeRoot('/a/b/')]).toEqual(['', '', '/chat', '/a/b']);
  });
});

for (const [label, express] of [['Express 4', express4], ['Express 5', express5]] as const) {
  describe(label, () => {
    function app(setup: (a: any) => void) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const a = express();
      setup(a);
      a.get('/mine', (_q: unknown, r: any) => r.json({ mine: true })); // eslint-disable-line @typescript-eslint/no-explicit-any
      return listen(http.createServer(a));
    }
    const mount = (a: any) => a.use('/chat', createNodeHandler(fake)); // eslint-disable-line @typescript-eslint/no-explicit-any

    it('mounted under a path: our routes work, the customer’s own routes keep working (fall through)', async () => {
      const base = await app(mount);
      expect((await (await fetch(`${base}/chat/api/v1/users`)).json()).path).toBe('/api/v1/users');
      expect(await (await fetch(`${base}/mine`)).json()).toEqual({ mine: true });
      expect((await fetch(`${base}/chat/unknown`)).status).toBe(404); // Express's own 404: next() was called
    });

    it('mounted first (the recommended setup): body streams, even with express.json() after it', async () => {
      const base = await app((a: any) => { mount(a); a.use(express.json()); }); // eslint-disable-line @typescript-eslint/no-explicit-any
      const r = await fetch(`${base}/chat/api/v1/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"k":1}' });
      expect((await r.json()).body).toBe('{"k":1}');
    });

    it('express.json() mounted BEFORE us: the parsed JSON is re-serialised', async () => {
      const base = await app((a: any) => { a.use(express.json()); mount(a); }); // eslint-disable-line @typescript-eslint/no-explicit-any
      const r = await fetch(`${base}/chat/api/v1/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' { "k" : 1 } ' });
      expect(JSON.parse((await r.json()).body)).toEqual({ k: 1 });
    });

    it('a body consumed by urlencoded or raw parsers is a clear 500 body_already_consumed', async () => {
      for (const [parser, type, body] of [
        [() => express.urlencoded({ extended: false }), 'application/x-www-form-urlencoded', 'a=1'],
        [() => express.raw({ type: '*/*' }), 'application/octet-stream', 'abc'],
      ] as const) {
        const base = await app((a: any) => { a.use(parser()); mount(a); }); // eslint-disable-line @typescript-eslint/no-explicit-any
        const r = await fetch(`${base}/chat/api/v1/x`, { method: 'POST', headers: { 'content-type': type }, body });
        const j = await r.json();
        expect(r.status).toBe(500);
        expect(j.error.code).toBe('body_already_consumed');
        expect(j.error.message).toContain('BEFORE body parsers');
      }
    });

    it('multipart stays streaming even with express.json() mounted first (it skips that content type)', async () => {
      const base = await app((a: any) => { a.use(express.json()); mount(a); }); // eslint-disable-line @typescript-eslint/no-explicit-any
      const form = new FormData();
      form.append('file', new Blob(['hello']), 'a.txt');
      const r = await fetch(`${base}/chat/api/v1/x`, { method: 'POST', body: form });
      const j = await r.json();
      expect(j.type).toMatch(/^multipart\/form-data/);
      expect(j.body).toContain('hello');
    });

    it('an empty POST with a JSON parser in front does not become "{}"', async () => {
      const base = await app((a: any) => { a.use(express.json()); mount(a); }); // eslint-disable-line @typescript-eslint/no-explicit-any
      const r = await fetch(`${base}/chat/api/v1/x`, { method: 'POST', headers: { 'content-type': 'application/json' } });
      expect((await r.json()).body).toBe('');
    });
  });
}
