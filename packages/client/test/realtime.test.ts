import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealtime, RealtimeError, type Realtime, type RealtimeStatus } from '../src/realtime';
import { startMiniServer, type MiniServer } from './realtimeServer';

const CONV = '11111111-1111-4111-8111-111111111111';
const CONV2 = '22222222-2222-4222-8222-222222222222';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function server(opts: Parameters<typeof startMiniServer>[0] = {}) {
  const s = await startMiniServer(opts);
  cleanups.push(() => s.close());
  return s;
}
function client(s: MiniServer, token: string | (() => string | Promise<string>) = 'user:alice', extra = {}) {
  const rt = createRealtime({ baseUrl: s.url, token, reconnectionDelayMs: 20, reconnectionDelayMaxMs: 100, rateLimitRetryMs: 20, ackTimeoutMs: 1500, ...extra });
  cleanups.push(() => rt.disconnect());
  return rt;
}
async function until(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const allow = (s: MiniServer, conv: string, ...users: string[]) => s.members.set(conv, new Set(users));
const caught = async (p: Promise<unknown>) => p.then(() => null, (e) => e as RealtimeError);
const track = (rt: Realtime) => {
  const seen: Array<{ status: RealtimeStatus; reconnected?: boolean }> = [];
  rt.onStatusChange((status, info) => seen.push({ status, reconnected: info.reconnected }));
  return seen;
};

describe('connecting', () => {
  it('connects with the token and reports status changes', async () => {
    const s = await server();
    const rt = client(s);
    const seen = track(rt);
    expect(rt.status).toBe('idle');
    await rt.connect();
    expect(rt.status).toBe('connected');
    expect(seen.map((x) => x.status)).toEqual(['connecting', 'connected']);
    expect(s.handshakes).toEqual(['user:alice']);
  });

  it('a missing token (function returning "") rejects with AUTH_REQUIRED and stays closed', async () => {
    const s = await server();
    const rt = client(s, () => '');
    const err = await caught(rt.connect());
    expect(err).toBeInstanceOf(RealtimeError);
    expect(err!.code).toBe('AUTH_REQUIRED');
    expect(rt.status).toBe('closed');
  });

  it('an invalid token rejects with INVALID_TOKEN and does not keep retrying', async () => {
    const s = await server();
    const rt = client(s, 'garbage');
    expect((await caught(rt.connect()))!.code).toBe('INVALID_TOKEN');
    await new Promise((r) => setTimeout(r, 300));
    expect(s.handshakes).toEqual(['garbage']); // exactly one attempt
  });

  it('an inactive project rejects with PROJECT_INACTIVE', async () => {
    const s = await server();
    expect((await caught(client(s, 'inactive').connect()))!.code).toBe('PROJECT_INACTIVE');
  });

  it('an unreachable server rejects with CONNECT_FAILED on the first attempt', async () => {
    const s = await server();
    const url = s.url;
    await s.close();
    const rt = createRealtime({ baseUrl: url, token: 'user:alice' });
    cleanups.push(() => rt.disconnect());
    expect((await caught(rt.connect()))!.code).toBe('CONNECT_FAILED');
    expect(rt.status).toBe('closed');
  });

  it('connect() twice shares one connection', async () => {
    const s = await server();
    const rt = client(s);
    await Promise.all([rt.connect(), rt.connect()]);
    await rt.connect();
    expect(s.handshakes).toHaveLength(1);
  });

  it('validates its options', () => {
    expect(() => createRealtime({ baseUrl: 'http://x', token: '' })).toThrow(TypeError);
    expect(() => createRealtime({ token: 'user:a' })).toThrow(TypeError); // no baseUrl outside a browser
  });
});

describe('rooms and events', () => {
  it('a participant joins and receives message.created; unsubscribing stops delivery', async () => {
    const s = await server();
    allow(s, CONV, 'alice');
    const rt = client(s);
    await rt.connect();
    const got: unknown[] = [];
    const off = rt.on('message.created', (m) => got.push(m));
    await rt.joinConversation(CONV);
    s.io.to(`conversation:${CONV}`).emit('message.created', { id: 'm1', content: 'hi' });
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ id: 'm1', content: 'hi' });
    off();
    s.io.to(`conversation:${CONV}`).emit('message.created', { id: 'm2' });
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toHaveLength(1);
  });

  it('a handler registered BEFORE connect() still receives events', async () => {
    const s = await server();
    allow(s, CONV, 'alice');
    const rt = client(s);
    const got: unknown[] = [];
    rt.on('message.created', (m) => got.push(m));
    await rt.connect();
    await rt.joinConversation(CONV);
    s.io.to(`conversation:${CONV}`).emit('message.created', { id: 'm1' });
    await until(() => got.length === 1);
  });

  it('a non-participant is rejected with FORBIDDEN and receives nothing', async () => {
    const s = await server();
    allow(s, CONV, 'someone-else');
    const rt = client(s);
    await rt.connect();
    const got: unknown[] = [];
    rt.on('message.created', (m) => got.push(m));
    expect((await caught(rt.joinConversation(CONV)))!.code).toBe('FORBIDDEN');
    s.io.to(`conversation:${CONV}`).emit('message.created', { id: 'm1' });
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toEqual([]);
  });

  it('a malformed conversation id is rejected with INVALID_PAYLOAD', async () => {
    const s = await server();
    const rt = client(s);
    await rt.connect();
    expect((await caught(rt.joinConversation('nope')))!.code).toBe('INVALID_PAYLOAD');
  });

  it('leaveConversation stops events for that room only', async () => {
    const s = await server();
    allow(s, CONV, 'alice');
    allow(s, CONV2, 'alice');
    const rt = client(s);
    await rt.connect();
    const got: Array<{ id: string }> = [];
    rt.on('message.created', (m) => got.push(m as unknown as { id: string }));
    await rt.joinConversation(CONV);
    await rt.joinConversation(CONV2);
    await rt.leaveConversation(CONV);
    s.io.to(`conversation:${CONV}`).emit('message.created', { id: 'left' });
    s.io.to(`conversation:${CONV2}`).emit('message.created', { id: 'kept' });
    await until(() => got.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(got.map((m) => m.id)).toEqual(['kept']);
  });

  it('untyped events work, reserved connection names are refused, a throwing handler does not break the others', async () => {
    const s = await server();
    allow(s, CONV, 'alice');
    const rt = client(s);
    expect(() => rt.on('connect', () => {})).toThrow(TypeError);
    const errors: RealtimeError[] = [];
    rt.onError((e) => errors.push(e));
    const got: unknown[] = [];
    rt.on('custom.event', () => { throw new Error('boom'); });
    rt.on('custom.event', (d) => got.push(d));
    await rt.connect();
    await rt.joinConversation(CONV);
    s.io.to(`conversation:${CONV}`).emit('custom.event', 42);
    await until(() => got.length === 1);
    expect(got).toEqual([42]);
    expect(errors[0]?.code).toBe('HANDLER_ERROR');
  });

  it('joinConversation before connect() rejects NOT_CONNECTED; after disconnect() rejects CLOSED', async () => {
    const s = await server();
    const rt = client(s);
    expect((await caught(rt.joinConversation(CONV)))!.code).toBe('NOT_CONNECTED');
    await rt.connect();
    rt.disconnect();
    expect(rt.status).toBe('closed');
    expect((await caught(rt.joinConversation(CONV)))!.code).toBe('CLOSED');
  });
});

describe('staying connected', () => {
  it('after the server restarts, it reconnects and re-joins the rooms by itself', async () => {
    const members = new Map<string, Set<string>>();
    const s1 = await server({ members });
    allow(s1, CONV, 'alice');
    const rt = client(s1);
    const seen = track(rt);
    const got: unknown[] = [];
    rt.on('message.created', (m) => got.push(m));
    await rt.connect();
    await rt.joinConversation(CONV);

    await s1.close();
    await until(() => rt.status === 'reconnecting');

    const s2 = await server({ port: s1.port, members });
    await until(() => rt.status === 'connected');
    expect(seen.at(-1)).toEqual({ status: 'connected', reconnected: true });

    s2.io.to(`conversation:${CONV}`).emit('message.created', { id: 'after-restart' });
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ id: 'after-restart' });
  });

  it('when the server kicks the socket (token expiry) it reconnects with a FRESH token from the token function', async () => {
    const s = await server();
    allow(s, CONV, 'alice');
    const tokens = vi.fn(() => 'user:alice');
    const rt2 = client(s, tokens);
    await rt2.connect();
    await rt2.joinConversation(CONV);
    expect(tokens).toHaveBeenCalledTimes(1);

    const got: unknown[] = [];
    rt2.on('message.created', (m) => got.push(m));
    s.io.disconnectSockets(true); // what the real server does when a token expires
    await until(() => rt2.status === 'reconnecting');
    await until(() => rt2.status === 'connected');
    expect(tokens.mock.calls.length).toBeGreaterThanOrEqual(2);

    s.io.to(`conversation:${CONV}`).emit('message.created', { id: 'fresh' });
    await until(() => got.length === 1);
  });

  it('a token FUNCTION whose token the server rejects keeps retrying (a fresh token may fix it) and recovers', async () => {
    const s = await server();
    const rt = client(s, () => 'user:alice');
    const errors: RealtimeError[] = [];
    rt.onError((e) => errors.push(e));
    await rt.connect();
    s.reject.code = 'INVALID_TOKEN';
    s.io.disconnectSockets(true);
    await until(() => errors.length >= 2); // several attempts, each reported
    expect(rt.status).toBe('reconnecting');
    delete s.reject.code; // the "refreshed token" is accepted now
    await until(() => rt.status === 'connected');
  });

  it('a STATIC token that the server now rejects closes for good instead of retrying forever', async () => {
    const s = await server();
    const rt = client(s, 'user:alice');
    const errors: RealtimeError[] = [];
    rt.onError((e) => errors.push(e));
    await rt.connect();
    // The server now refuses this token (e.g. it expired): break the handshake for every later attempt.
    s.reject.code = 'INVALID_TOKEN';
    s.io.disconnectSockets(true);
    await until(() => rt.status === 'closed');
    expect(errors.some((e) => e.code === 'INVALID_TOKEN')).toBe(true);
    const attempts = s.handshakes.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(s.handshakes.length).toBe(attempts); // no background retries after it closed
  });

  it('a conversation the user can no longer join is dropped on reconnect and reported through onError', async () => {
    const s = await server();
    allow(s, CONV, 'alice');
    allow(s, CONV2, 'alice');
    const rt = client(s);
    const errors: RealtimeError[] = [];
    rt.onError((e) => errors.push(e));
    await rt.connect();
    await rt.joinConversation(CONV);
    await rt.joinConversation(CONV2);
    s.members.get(CONV)!.delete('alice'); // removed while we are connected
    const got: Array<{ id: string }> = [];
    rt.on('message.created', (m) => got.push(m as unknown as { id: string }));
    s.io.disconnectSockets(true);
    await until(() => errors.length === 1);
    await until(() => rt.status === 'connected');
    expect(errors[0].code).toBe('FORBIDDEN');
    s.io.to(`conversation:${CONV}`).emit('message.created', { id: 'gone' });
    s.io.to(`conversation:${CONV2}`).emit('message.created', { id: 'still' });
    await until(() => got.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(got.map((m) => m.id)).toEqual(['still']);
  });

  it('rejoin retries when the server answers RATE_LIMITED', async () => {
    const s = await server({ rateLimitFirstJoins: 0 });
    allow(s, CONV, 'alice');
    const rt = client(s);
    await rt.connect();
    await rt.joinConversation(CONV);
    await s.close();
    await until(() => rt.status === 'reconnecting');
    const s2 = await server({ port: s.port, members: s.members, rateLimitFirstJoins: 2 }); // first two joins per socket are refused
    await until(() => rt.status === 'connected', 6000);
    const got: unknown[] = [];
    rt.on('message.created', (m) => got.push(m));
    s2.io.to(`conversation:${CONV}`).emit('message.created', { id: 'x' });
    await until(() => got.length === 1);
  });

  it('a join issued while reconnecting waits for the connection instead of failing', async () => {
    const members = new Map<string, Set<string>>();
    const s1 = await server({ members });
    allow(s1, CONV, 'alice');
    const rt = client(s1);
    await rt.connect();
    await s1.close();
    await until(() => rt.status === 'reconnecting');
    const pending = rt.joinConversation(CONV);
    await server({ port: s1.port, members });
    await expect(pending).resolves.toBeUndefined();
  });

  it('disconnect() while reconnecting rejects pending joins with CLOSED and stops reconnecting', async () => {
    const s1 = await server();
    allow(s1, CONV, 'alice');
    const rt = client(s1);
    await rt.connect();
    await s1.close();
    await until(() => rt.status === 'reconnecting');
    const pending = caught(rt.joinConversation(CONV));
    rt.disconnect();
    expect((await pending)!.code).toBe('CLOSED');
    expect(rt.status).toBe('closed');
  });
});

describe('optional peer dependency', () => {
  it('gives a clear error when socket.io-client is not installed', async () => {
    vi.resetModules();
    vi.doMock('socket.io-client', () => { throw new Error("Cannot find package 'socket.io-client'"); });
    const mod = await import('../src/realtime');
    const rt = mod.createRealtime({ baseUrl: 'http://127.0.0.1:1', token: 'user:a' });
    const err = (await rt.connect().then(() => null, (e) => e)) as RealtimeError;
    expect(err.code).toBe('SOCKET_IO_MISSING');
    expect(err.message).toMatch(/npm i socket\.io-client/);
    vi.doUnmock('socket.io-client');
    vi.resetModules();
  });
});
