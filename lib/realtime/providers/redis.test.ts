import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// socketio.ts imports the auth/db modules, which insist on these at load time. Nothing here uses them
// (the pool is lazy, no connection is made), so placeholders are fine when they are not set.
vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'redis-test-placeholder';
  process.env.DATABASE_URL ||= 'postgres://placeholder:placeholder@127.0.0.1:1/placeholder';
});

import http from 'http';
import type { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { attachRedisAdapter, type RedisAttachment } from './redis';
import { createSocketIoProvider } from './socketio';
import type { RealtimeProvider } from '../types';

/**
 * Stage 5.6 tests. Need a Redis: REDIS_URL=redis://127.0.0.1:6379 (skipped otherwise).
 * Two Socket.IO servers in one process stand in for two instances; they share nothing but Redis.
 * (No database needed: rooms are joined server-side. Handshake/join rules are covered in socketio.test.ts.)
 */
const REDIS_URL = process.env.REDIS_URL;
const ROOM = `conversation:redis-test-${process.pid}-${Date.now()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Instance {
  server: http.Server;
  io: Server;
  url: string;
  redis: RedisAttachment;
  provider: RealtimeProvider;
}

async function startInstance(redisUrl: string): Promise<Instance> {
  const server = http.createServer();
  const io = new Server(server, { serveClient: false });
  io.on('connection', (socket) => {
    // test hook: a client asks to be put in the room (the real join rules live in socketio.ts)
    socket.on('join', async (ack: () => void) => {
      await socket.join(ROOM);
      ack();
    });
  });
  const redis = await attachRedisAdapter(io, redisUrl);
  const provider = createSocketIoProvider(io, { redis });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, io, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, redis, provider };
}

describe.skipIf(!REDIS_URL)('redis adapter (two instances, real Redis)', () => {
  let a: Instance;
  let b: Instance;
  const clients: ClientSocket[] = [];

  const client = async (inst: Instance, joinRoom = true) => {
    const c = connect(inst.url, { transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(c);
    await new Promise<void>((res, rej) => { c.once('connect', () => res()); c.once('connect_error', rej); });
    if (joinRoom) await new Promise<void>((res) => c.emit('join', () => res()));
    return c;
  };
  const next = (c: ClientSocket, name: string, ms = 1000) =>
    new Promise<unknown>((res) => { const t = setTimeout(() => res('__none__'), ms); c.once(name, (d) => { clearTimeout(t); res(d); }); });

  beforeAll(async () => {
    a = await startInstance(REDIS_URL!);
    b = await startInstance(REDIS_URL!);
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    for (const inst of [a, b]) {
      await inst?.provider.close?.().catch(() => {});
      await new Promise<void>((r) => inst?.server.close(() => r())).catch(() => {});
    }
  });

  it('an event published on instance A reaches a client connected to instance B (and A\'s own)', async () => {
    const onA = await client(a);
    const onB = await client(b);
    const gotA = next(onA, 'message.created');
    const gotB = next(onB, 'message.created');
    await a.provider.publish(ROOM, { type: 'message.created', data: { id: 'from-a' } });
    expect(await gotA).toEqual({ id: 'from-a' });
    expect(await gotB).toEqual({ id: 'from-a' });
  });

  it('and the other way round (B -> A)', async () => {
    const onA = await client(a);
    const gotA = next(onA, 'message.created');
    await b.provider.publish(ROOM, { type: 'message.created', data: { id: 'from-b' } });
    expect(await gotA).toEqual({ id: 'from-b' });
  });

  it('still only reaches clients in the room, on either instance', async () => {
    const outsiderA = await client(a, false);
    const outsiderB = await client(b, false);
    const gotA = next(outsiderA, 'message.created', 500);
    const gotB = next(outsiderB, 'message.created', 500);
    await a.provider.publish(ROOM, { type: 'message.created', data: { id: 'private' } });
    expect(await gotA).toBe('__none__');
    expect(await gotB).toBe('__none__');
  });

  it('exposes redisReady in stats', () => {
    expect(a.provider.stats?.().redisReady).toBe(1);
  });

  it('shutting down instance A does NOT disconnect clients on instance B (local-only disconnect)', async () => {
    const onA = await client(a);
    const onB = await client(b);
    const aGone = new Promise<string>((res) => onA.once('disconnect', (r) => res(r)));
    let bDropped = false;
    onB.once('disconnect', () => { bDropped = true; });

    await a.provider.close!();
    expect(await aGone).toBeTruthy();
    await sleep(300);
    expect(bDropped).toBe(false);
    expect(onB.connected).toBe(true);

    // B keeps working on its own
    const got = next(onB, 'message.created');
    await b.provider.publish(ROOM, { type: 'message.created', data: { id: 'after-a-closed' } });
    expect(await got).toEqual({ id: 'after-a-closed' });
  });
});

describe('redis adapter when Redis is unreachable (no Redis needed)', () => {
  it('starts anyway, keeps delivering locally, never throws or rejects unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const inst = await startDead();
      const c = connect(inst.url, { transports: ['websocket'], reconnection: false, forceNew: true });
      await new Promise<void>((res) => c.once('connect', () => res()));
      await new Promise<void>((res) => c.emit('join', () => res()));

      expect(inst.provider.stats?.().redisReady).toBe(0);
      const got = new Promise<unknown>((res) => c.once('message.created', res));
      await inst.provider.publish(ROOM, { type: 'message.created', data: { id: 'local' } });
      expect(await got).toEqual({ id: 'local' }); // same-instance delivery survives the outage

      await sleep(500); // let the failed publish settle
      expect(unhandled).toEqual([]);
      c.close();
      await inst.provider.close!();
      await new Promise<void>((r) => inst.server.close(() => r())).catch(() => {});
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 15000);

  async function startDead(): Promise<Instance> {
    return startInstance('redis://127.0.0.1:1'); // nothing listens on port 1
  }
});
