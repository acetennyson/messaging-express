import { afterEach, describe, expect, it } from 'vitest';
import { createClient, MessagingExpressError } from '../src';
import { json, startMockServer } from './mockServer';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('transport', () => {
  it('parses the server error shape into MessagingExpressError', async () => {
    const s = await startMockServer((_req, res) => json(res, 404, { error: { message: 'Conversation not found', code: 'NOT_FOUND' } }));
    closers.push(s.close);
    const client = createClient({ baseUrl: s.url, token: 't' });
    const err = await client.request('GET', '/api/v1/x').catch((e) => e);
    expect(err).toBeInstanceOf(MessagingExpressError);
    expect(err).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Conversation not found' });
  });

  it('honors Retry-After on 429 for a GET, then succeeds', async () => {
    let n = 0;
    const s = await startMockServer((_req, res) =>
      n++ === 0 ? json(res, 429, { error: { message: 'Too many requests', code: 'RATE_LIMIT_EXCEEDED' } }, { 'Retry-After': '1' }) : json(res, 200, { data: 'ok' })
    );
    closers.push(s.close);
    const started = Date.now();
    const res = await createClient({ baseUrl: s.url, token: 't' }).request('GET', '/x');
    expect(res.data).toBe('ok');
    expect(n).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950); // waited the 1 s the server asked for
  });

  it('gives up immediately when Retry-After is longer than maxRetryAfterMs, exposing retryAfter', async () => {
    const s = await startMockServer((_req, res) => json(res, 429, { error: { message: 'slow down', code: 'RATE_LIMIT_EXCEEDED' } }, { 'Retry-After': '120' }));
    closers.push(s.close);
    const err = await createClient({ baseUrl: s.url, token: 't', maxRetryAfterMs: 5000 }).request('GET', '/x').catch((e) => e);
    expect(err).toMatchObject({ status: 429, code: 'RATE_LIMIT_EXCEEDED', retryAfter: 120 });
    expect(s.requests.length).toBe(1);
  });

  it('retries 503 on a GET at most maxRetries times', async () => {
    const s = await startMockServer((_req, res) => json(res, 503, { error: { message: 'down', code: 'X' } }));
    closers.push(s.close);
    const err = await createClient({ baseUrl: s.url, token: 't', maxRetries: 2 }).request('GET', '/x').catch((e) => e);
    expect(err.status).toBe(503);
    expect(s.requests.length).toBe(3); // 1 try + 2 retries
  }, 10_000);

  it('never retries a POST unless the caller opts in', async () => {
    const s = await startMockServer((_req, res) => json(res, 503, { error: { message: 'down', code: 'X' } }));
    closers.push(s.close);
    await createClient({ baseUrl: s.url, token: 't' }).request('POST', '/messages', { body: { a: 1 } }).catch(() => {});
    expect(s.requests.length).toBe(1);
  });

  it('does not retry client errors (400)', async () => {
    const s = await startMockServer((_req, res) => json(res, 400, { error: { message: 'bad', code: 'VALIDATION_ERROR' } }));
    closers.push(s.close);
    await createClient({ baseUrl: s.url, token: 't' }).request('GET', '/x').catch(() => {});
    expect(s.requests.length).toBe(1);
  });

  it('turns a refused connection into a NETWORK_ERROR with status 0', async () => {
    const err = await createClient({ baseUrl: 'http://127.0.0.1:1', token: 't', maxRetries: 0 }).request('GET', '/x').catch((e) => e);
    expect(err).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('awaits the token function before every request and sends JSON bodies', async () => {
    let n = 0;
    const s = await startMockServer((_req, res) => json(res, 201, { data: { ok: true } }));
    closers.push(s.close);
    const client = createClient({ baseUrl: s.url, token: async () => { await new Promise((r) => setTimeout(r, 5)); return `t${++n}`; } });
    await client.request('POST', '/a', { body: { x: 1 } });
    await client.request('GET', '/b', { query: { limit: 5, skip: undefined } });
    expect(s.requests.map((r) => r.headers.authorization)).toEqual(['Bearer t1', 'Bearer t2']);
    expect(s.requests[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(s.requests[0].body.toString())).toEqual({ x: 1 });
    expect(s.requests[1].url).toBe('/b?limit=5');
  });
});
