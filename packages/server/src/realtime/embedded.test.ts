/**
 * M7 integration: realtime, events and webhooks on the embedded module, against a real Postgres (DATABASE_URL), in a
 * throwaway schema created and migrated here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import { createRequire } from 'module';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { Server as IoServer } from 'socket.io';
import { io as connectClient, type Socket } from 'socket.io-client';
import { MessagingServer } from '../server';
import type { ModuleEvent } from './audience';

const URL_ = process.env.TEST_SCHEMA_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'm7-realtime-secret-m7-realtime-secret-xx';
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const express4 = createRequire(__filename)('express4');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 4000, what = 'condition'): Promise<void> {
  const t = Date.now();
  while (!(await cond())) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe.skipIf(!URL_)('embedded realtime, events and webhooks', () => {
  const schema = `m7_${randomBytes(4).toString('hex')}`;
  const admin = new Pool({ connectionString: URL_, max: 2 });
  const open: Array<() => Promise<void>> = [];
  const sign = (payload: object) => jwt.sign(payload, SECRET, { expiresIn: '1h' });
  const api = sign({ type: 'api' });

  let n = 0;
  const init = async (extra: object = {}) => {
    const s = await MessagingServer.init({ database: URL_!, jwtSecret: SECRET, schema, projectName: `p${++n}`, logger: silent, ...extra });
    open.push(() => s.close({ timeoutMs: 500 }));
    return s;
  };
  const call = async (s: MessagingServer, method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await s.handler(
      new Request(`http://chat.test${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      })
    );
    return { status: res.status, json: (await res.json().catch(() => null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const mkUser = async (s: MessagingServer, name: string) =>
    (await call(s, 'POST', '/api/v1/users', api, { externalId: `${name}-${randomBytes(3).toString('hex')}`, name })).json.data.id as string;
  const mkGroup = async (s: MessagingServer, ids: string[]) =>
    (await call(s, 'POST', '/api/v1/conversations', api, { type: 'group', participantIds: ids })).json.data.id as string;
  const post = (s: MessagingServer, conv: string, sender: string, content = 'hi') =>
    call(s, 'POST', '/api/v1/messages', sign({ type: 'user', userId: sender }), { conversationId: conv, senderId: sender, content });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await MessagingServer.migrate({ database: URL_!, schema });
  }, 120_000);
  afterAll(async () => {
    for (const close of open.reverse()) await close().catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  const sockets: Socket[] = [];
  afterAll(() => sockets.forEach((x) => x.close()));
  const connect = (base: string, token: string, extra: object = {}) => {
    const sock = connectClient(base, { path: '/chat/socket.io', auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true, ...extra });
    sockets.push(sock);
    return sock;
  };
  const joined = (sock: Socket, conversationId: string) => new Promise<{ ok: boolean; code?: string }>((r) => sock.emit('join-conversation', { conversationId }, r));
  const opened = (sock: Socket) => new Promise<void>((res, rej) => { sock.once('connect', () => res()); sock.once('connect_error', rej); });


  describe('authorizeJoin and listAudience', () => {
    it('member yes; non-member, removed member, user of another conversation, unknown and malformed ids no', async () => {
      const s = await init();
      const [alice, bob, eve, carol] = [await mkUser(s, 'alice'), await mkUser(s, 'bob'), await mkUser(s, 'eve'), await mkUser(s, 'carol')];
      const conv = await mkGroup(s, [alice, bob]);
      await mkGroup(s, [eve, carol]); // eve belongs to a DIFFERENT conversation

      expect(await s.authorizeJoin(alice, conv)).toBe(true);
      expect(await s.authorizeJoin(bob, conv)).toBe(true);
      expect(await s.authorizeJoin(eve, conv)).toBe(false);
      expect(await s.authorizeJoin(randomUUID(), conv)).toBe(false);
      expect(await s.authorizeJoin(alice, randomUUID())).toBe(false);
      expect(await s.authorizeJoin('not-a-uuid', conv)).toBe(false);
      expect(await s.authorizeJoin(alice, "x' OR '1'='1")).toBe(false);

      expect((await call(s, 'DELETE', `/api/v1/conversations/${conv}/participants/${bob}`, api)).status).toBe(200);
      expect(await s.authorizeJoin(bob, conv)).toBe(false); // removed: refused on the very next check
      expect(await s.authorizeJoin(alice, conv)).toBe(true);
    });

    it('a conversation of another project never authorizes', async () => {
      const a = await init();
      const b = await init(); // second project in the same schema
      const u = await mkUser(a, 'alice');
      const conv = await mkGroup(a, [u]);
      expect(await a.authorizeJoin(u, conv)).toBe(true);
      expect(await b.authorizeJoin(u, conv)).toBe(false);
    });

    it('listAudience pages a conversation in order without repeats, and handles users audiences', async () => {
      const s = await init();
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push(await mkUser(s, `m${i}`));
      const conv = await mkGroup(s, ids);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: { userIds: string[]; nextCursor: string | null } = await s.listAudience({ kind: 'conversation', conversationId: conv }, { limit: 2, cursor });
        seen.push(...page.userIds);
        cursor = page.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toEqual([...ids].sort());
      expect((await s.listAudience({ kind: 'users', userIds: ['b', 'a', 'a'] })).userIds).toEqual(['a', 'b']);
      expect((await s.listAudience({ kind: 'conversation', conversationId: randomUUID() })).userIds).toEqual([]);
      expect((await s.listAudience({ kind: 'conversation', conversationId: 'junk' })).userIds).toEqual([]);
    });
  });

  describe('custom transport (onEvent), following the documented pattern', () => {
    /** The pattern from docs/realtime.md: authorize once at subscribe, route by audience, evict on participant.removed. */
    function transport(s: MessagingServer) {
      const rooms = new Map<string, Set<string>>();
      const inbox = new Map<string, ModuleEvent[]>();
      const events: ModuleEvent[] = [];
      s.onEvent(async (ev) => {
        events.push(ev);
        if (ev.type === 'participant.removed') {
          const d = ev.data as { conversationId: string; userId: string };
          rooms.get(d.conversationId)?.delete(d.userId);
        }
        const to = ev.audience.kind === 'users' ? ev.audience.userIds : [...(rooms.get(ev.audience.conversationId) ?? [])];
        for (const u of to) inbox.set(u, [...(inbox.get(u) ?? []), ev]);
      });
      return {
        events,
        got: (u: string, type: string) => (inbox.get(u) ?? []).filter((e) => e.type === type),
        subscribe: async (u: string, conv: string) => {
          if (!(await s.authorizeJoin(u, conv))) return false;
          rooms.set(conv, (rooms.get(conv) ?? new Set()).add(u));
          return true;
        },
      };
    }

    it('a non-member never receives a conversation event; members do; message.created carries a conversation audience', async () => {
      const s = await init();
      const t = transport(s);
      const [alice, bob, eve] = [await mkUser(s, 'alice'), await mkUser(s, 'bob'), await mkUser(s, 'eve')];
      const conv = await mkGroup(s, [alice, bob]);
      expect(await t.subscribe(alice, conv)).toBe(true);
      expect(await t.subscribe(bob, conv)).toBe(true);
      expect(await t.subscribe(eve, conv)).toBe(false); // refused at subscribe time: the only gate

      expect((await post(s, conv, alice, 'secret plans')).status).toBe(201);
      await until(() => t.got(bob, 'message.created').length === 1, 4000, 'message.created for bob');
      expect(t.got(alice, 'message.created')).toHaveLength(1);
      expect(t.got(eve, 'message.created')).toHaveLength(0);
      const ev = t.events.find((e) => e.type === 'message.created')!;
      expect(ev.audience).toEqual({ kind: 'conversation', conversationId: conv });
      expect(JSON.stringify(ev.audience)).not.toContain(bob); // no recipient list is materialised per event
      expect((await s.listAudience(ev)).userIds.sort()).toEqual([alice, bob].sort());
    });

    it('a removed member is evicted on participant.removed and misses the next message', async () => {
      const s = await init();
      const t = transport(s);
      const [alice, bob] = [await mkUser(s, 'alice'), await mkUser(s, 'bob')];
      const conv = await mkGroup(s, [alice, bob]);
      await t.subscribe(alice, conv);
      await t.subscribe(bob, conv);

      expect((await call(s, 'DELETE', `/api/v1/conversations/${conv}/participants/${bob}`, api)).status).toBe(200);
      await until(() => t.events.some((e) => e.type === 'participant.removed'), 4000, 'participant.removed');
      const removed = t.events.find((e) => e.type === 'participant.removed')!;
      expect(removed.data).toMatchObject({ conversationId: conv, userId: bob }); // names the user even when not encrypted
      expect(removed.audience).toEqual({ kind: 'users', userIds: [bob] });

      await post(s, conv, alice, 'after removal');
      await until(() => t.got(alice, 'message.created').length === 1, 4000, 'alice message');
      await sleep(100);
      expect(t.got(bob, 'message.created')).toHaveLength(0);
    });

    it('a private event names only its owner (device.added for a user with no shared conversations)', async () => {
      const s = await init();
      const t = transport(s);
      const carol = await mkUser(s, 'carol');
      const key = () => randomBytes(32).toString('base64url');
      const tc = sign({ type: 'user', userId: carol });
      const first = await call(s, 'POST', '/api/v1/devices', tc, { publicKey: key() });
      expect(first.status).toBeLessThan(300);
      const newKey = key(); // a second device: the first approves its key (pair), then it links
      expect((await call(s, 'POST', '/api/v1/devices/pair', tc, { publicKey: newKey }, { 'x-device-id': first.json.data.id })).status).toBe(200);
      expect((await call(s, 'POST', '/api/v1/devices/link', tc, { publicKey: newKey, deviceName: 'phone' })).status).toBe(201);
      await until(() => t.events.some((e) => e.type === 'device.added'), 4000, 'device.added');
      const added = t.events.filter((e) => e.type === 'device.added');
      expect(added).toHaveLength(1);
      expect(added[0].audience).toEqual({ kind: 'users', userIds: [carol] });
    });

    it('onEvent and attachRealtime exclude each other; a closed instance refuses both', async () => {
      const s = await init();
      s.onEvent(() => {});
      expect(() => s.onEvent(() => {})).toThrow(/already provided/);
      await expect(s.attachRealtime(http.createServer())).rejects.toThrow(/already provided/);
      const c = await init();
      await c.close({ timeoutMs: 200 });
      expect(() => c.onEvent(() => {})).toThrow(/closed/);
    });
  });

  describe('attachRealtime (Socket.IO) on an Express host', () => {
    async function host(s: MessagingServer, opts: Parameters<MessagingServer['attachRealtime']>[1] = {}) {
      const app = express4();
      s.middleware(app, '/chat');
      const server = http.createServer(app);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      await s.attachRealtime(server, opts);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      open.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
      return { server, base };
    }
    it('same rules as the hosted server: members join and receive events, outsiders are refused, bad tokens fail the handshake', async () => {
      const s = await init();
      const { base } = await host(s);
      const [alice, bob, eve] = [await mkUser(s, 'alice'), await mkUser(s, 'bob'), await mkUser(s, 'eve')];
      const conv = await mkGroup(s, [alice, bob]);

      const sa = connect(base, sign({ type: 'user', userId: alice }));
      const se = connect(base, sign({ type: 'user', userId: eve }));
      await Promise.all([opened(sa), opened(se)]);
      expect(await joined(sa, conv)).toEqual({ ok: true });
      expect(await joined(se, conv)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await joined(sa, 'nope')).toEqual({ ok: false, code: 'INVALID_PAYLOAD' });

      const got: unknown[] = [];
      const eveGot: unknown[] = [];
      sa.on('message.created', (d) => got.push(d));
      se.on('message.created', (d) => eveGot.push(d));
      await post(s, conv, bob, 'hello alice');
      await until(() => got.length === 1, 4000, 'message over the socket');
      expect(eveGot).toHaveLength(0);

      for (const [token, code] of [['', 'AUTH_REQUIRED'], ['garbage', 'INVALID_TOKEN']] as const) {
        const bad = connect(base, token);
        const err: any = await new Promise((r) => bad.once('connect_error', r)); // eslint-disable-line @typescript-eslint/no-explicit-any
        expect(err.data?.code).toBe(code);
      }
    });

    it('removal evicts the user from the room: they miss the next message', async () => {
      const s = await init();
      const { base } = await host(s);
      const [alice, bob] = [await mkUser(s, 'alice'), await mkUser(s, 'bob')];
      const conv = await mkGroup(s, [alice, bob]);
      const sb = connect(base, sign({ type: 'user', userId: bob }));
      await opened(sb);
      expect(await joined(sb, conv)).toEqual({ ok: true });
      const got: unknown[] = [];
      sb.on('message.created', (d) => got.push(d));
      await call(s, 'DELETE', `/api/v1/conversations/${conv}/participants/${bob}`, api);
      await sleep(300);
      await post(s, conv, alice, 'after');
      await sleep(300);
      expect(got).toHaveLength(0);
      expect(await joined(sb, conv)).toEqual({ ok: false, code: 'FORBIDDEN' }); // and cannot rejoin
    });

    it('attaching twice to one http.Server rejects; the customer’s other upgrade handling is not destroyed', async () => {
      const s = await init();
      const { server } = await host(s);
      await expect(s.attachRealtime(server)).rejects.toThrow(/already/);
      const other = await init();
      await expect(other.attachRealtime(server)).rejects.toThrow(/already has/);
    });

    it('a Socket.IO server you pass in is borrowed: we live in our own namespace and never close yours', async () => {
      const s = await init();
      const server = http.createServer();
      const mine = new IoServer(server, { path: '/socket.io' });
      let theirs = 0;
      mine.on('connection', () => theirs++); // their own default namespace, no token required
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      open.push(() => new Promise<void>((r) => { mine.local.disconnectSockets(true); server.closeAllConnections(); server.close(() => r()); }));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await s.attachRealtime(server, { io: mine });
      await expect(s.attachRealtime(server, { io: mine })).rejects.toThrow();

      const theirSocket = connectClient(base, { transports: ['websocket'], reconnection: false, forceNew: true }); // no token
      sockets.push(theirSocket);
      await opened(theirSocket);
      expect(theirs).toBe(1);

      const [alice] = [await mkUser(s, 'alice')];
      const conv = await mkGroup(s, [alice]);
      const ours = connectClient(`${base}/messaging-express`, { auth: { token: sign({ type: 'user', userId: alice }) }, transports: ['websocket'], reconnection: false, forceNew: true });
      sockets.push(ours);
      await opened(ours);
      expect(await joined(ours, conv)).toEqual({ ok: true });
      const got: unknown[] = [];
      ours.on('message.created', (d) => got.push(d));
      await post(s, conv, alice, 'ns');
      await until(() => got.length === 1, 4000, 'namespaced event');

      await s.close({ timeoutMs: 500 });
      await until(() => !ours.connected, 3000, 'our socket to be disconnected');
      expect(theirSocket.connected).toBe(true); // yours stays up
      expect(mine.sockets.sockets.size).toBe(1);
    });

    it('close() disconnects our sockets, refuses new handshakes and leaves the http server listening', async () => {
      const s = await init();
      const { server, base } = await host(s);
      const alice = await mkUser(s, 'alice');
      const sa = connect(base, sign({ type: 'user', userId: alice }));
      await opened(sa);
      await s.close({ timeoutMs: 500 });
      await until(() => !sa.connected, 3000, 'disconnect');
      expect(server.listening).toBe(true);
      expect((await fetch(`${base}/chat/api/v1/users`)).status).toBe(503);
    });
  });

  describe('no extra database query per message.created', () => {
    it('the same POST costs the same number of queries with no realtime, a custom transport, or a connected socket', async () => {
      async function measure(mode: 'none' | 'custom' | 'socketio'): Promise<number> {
        let count = 0;
        const pool = new Pool({ connectionString: URL_, max: 4 });
        pool.on('connect', (client) => {
          const q = client.query.bind(client) as (...a: unknown[]) => unknown;
          (client as unknown as { query: unknown }).query = (...a: unknown[]) => { count++; return q(...a); };
        });
        const s = await MessagingServer.init({ database: pool, jwtSecret: SECRET, schema, projectName: `q-${mode}-${++n}`, logger: silent });
        const users = [await mkUser(s, 'a'), await mkUser(s, 'b')];
        const conv = await mkGroup(s, users);
        let server: http.Server | undefined;
        let sock: Socket | undefined;
        let delivered = 0;
        if (mode === 'custom') s.onEvent(() => { delivered++; });
        if (mode === 'socketio') {
          server = http.createServer(s.nodeHandler({ root: '/chat' }));
          await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
          await s.attachRealtime(server);
          sock = connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, sign({ type: 'user', userId: users[0] }));
          await opened(sock);
          await joined(sock, conv);
          sock.on('message.created', () => delivered++);
        }
        await post(s, conv, users[0], 'warm up'); // caches and first-use paths out of the way
        if (mode !== 'none') await until(() => delivered >= 1, 4000, 'warm-up delivery');
        await sleep(100);
        count = 0;
        await post(s, conv, users[0], 'measured');
        if (mode !== 'none') await until(() => delivered >= 2, 4000, 'measured delivery');
        await sleep(150);
        const measured = count;
        sock?.close();
        await s.close({ timeoutMs: 500, database: 'close' });
        if (server) await new Promise<void>((r) => { server!.closeAllConnections(); server!.close(() => r()); });
        return measured;
      }
      const none = await measure('none');
      expect(none).toBeGreaterThan(0);
      expect(await measure('custom')).toBe(none);
      expect(await measure('socketio')).toBe(none);
    });
  });

  describe('webhooks', () => {
    function receiver() {
      const got: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
      let status = 200;
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          got.push({ headers: req.headers, body });
          res.statusCode = status;
          res.end('{}');
        });
      });
      return {
        got,
        setStatus: (s: number) => (status = s),
        start: async () => {
          await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
          open.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
          return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
        },
      };
    }

    it('sends a signed event to the url from init; a failed delivery is retried by the in-process loop, which close() stops', async () => {
      const rx = receiver();
      const url = await rx.start();
      const s = await init({ webhook: { url, secret: 'whsec_test', retryIntervalMs: 1000 } });
      const [alice, bob] = [await mkUser(s, 'alice'), await mkUser(s, 'bob')];
      const conv = await mkGroup(s, [alice, bob]);

      await post(s, conv, alice, 'first');
      await until(() => rx.got.some((g) => g.headers['x-webhook-event'] === 'message.created'), 4000, 'first webhook');
      const first = rx.got.find((g) => g.headers['x-webhook-event'] === 'message.created')!;
      const expected = `sha256=${createHmac('sha256', 'whsec_test').update(first.body).digest('hex')}`;
      expect(first.headers['x-webhook-signature']).toBe(expected);
      expect(JSON.parse(first.body)).toMatchObject({ event: 'message.created', data: { content: 'first' } });

      rx.setStatus(500);
      const before = rx.got.length;
      await post(s, conv, alice, 'second');
      await until(() => rx.got.length > before, 4000, 'failing delivery');
      // make the recorded failure due now, then let the loop deliver it
      await admin.query(`UPDATE ${schema}.mx_webhook_logs SET next_retry_at = NOW() WHERE completed_at IS NULL`);
      rx.setStatus(200);
      const afterFail = rx.got.length;
      await until(() => rx.got.length > afterFail, 6000, 'retry delivery');
      await until(async () => (await admin.query(`SELECT count(*)::int n FROM ${schema}.mx_webhook_logs WHERE completed_at IS NULL`)).rows[0].n === 0, 4000, 'log completed');

      await s.close({ timeoutMs: 500 });
      const settled = rx.got.length;
      await admin.query(`INSERT INTO ${schema}.mx_webhook_logs (project_id, event_type, payload, url, attempts, next_retry_at) SELECT $1, 'x', '{}'::jsonb, $2, 1, NOW() FROM generate_series(1,1)`, [s.projectId, url]);
      await sleep(1600);
      expect(rx.got.length).toBe(settled); // the loop is stopped
    }, 30_000);

    it('bad webhook options are named', async () => {
      for (const webhook of [{ url: 'ftp://x' }, { url: 'nope' }, {}, { url: 'http://x.test', retryIntervalMs: 5 }, { url: 'http://x.test', secret: '' }, { url: 'http://x.test', extra: 1 }]) {
        await expect(MessagingServer.init({ database: URL_!, jwtSecret: SECRET, schema, logger: silent, webhook } as never)).rejects.toThrow(/webhook/);
      }
    });
  });
});
