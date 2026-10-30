import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import jwt from 'jsonwebtoken';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'net';

/**
 * Real-Postgres + real-socket tests for Stage 5.3. Need DATABASE_URL pointing at a migrated DB
 * containing the seed (scripts/smoke-seed.sql). Skipped when DATABASE_URL is unset.
 * Creates a second organization/project/user and a non-participant user, removes them afterwards.
 */
const hasDb = !!process.env.DATABASE_URL;
process.env.JWT_SECRET ||= 'socketio-test-secret';
const SECRET = process.env.JWT_SECRET!;

const PROJECT = '00000000-0000-4000-8000-0000000000a2';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const CONV = '00000000-0000-4000-8000-0000000000c1';
const USER_IN = '00000000-0000-4000-8000-0000000000b1'; // participant
const TAG = `s${process.pid}x${Date.now()}`;

const sign = (payload: object, opts: jwt.SignOptions = { expiresIn: '1h' }) => jwt.sign(payload, SECRET, opts);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasDb)('socket.io provider (real database, real sockets)', () => {
  let httpServer: http.Server;
  let url = '';
  let publish: (channel: string, type: string, data: unknown) => Promise<void>;
  let closeProvider: () => Promise<void>;
  let q: typeof import('../../db/pool').query;
  const clients: ClientSocket[] = [];
  let outsider = ''; // user in the seed project, NOT in CONV
  let otherProjectId = '';
  let otherProjectUser = '';
  let otherOrgId = '';

  const client = (token?: string | null, extra: Record<string, unknown> = {}) => {
    const c = connect(url, {
      auth: token === null ? {} : { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      ...extra,
    });
    clients.push(c);
    return c;
  };
  const connected = (c: ClientSocket) =>
    new Promise<void>((res, rej) => {
      c.once('connect', () => res());
      c.once('connect_error', (e) => rej(e));
    });
  const connectError = (c: ClientSocket) =>
    new Promise<Error & { data?: { code?: string } }>((res) => {
      c.once('connect_error', (e) => res(e));
    });
  const join = (c: ClientSocket, conversationId: unknown) =>
    new Promise<{ ok: boolean; code?: string }>((res) => c.emit('join-conversation', { conversationId }, res));
  const nextEvent = (c: ClientSocket, name: string, ms = 600) =>
    new Promise<unknown>((res) => {
      const t = setTimeout(() => res('__none__'), ms);
      c.once(name, (d) => {
        clearTimeout(t);
        res(d);
      });
    });

  beforeAll(async () => {
    ({ query: q } = await import('../../db/pool'));
    const { createSocketIoServer, createSocketIoProvider } = await import('./socketio');

    httpServer = http.createServer();
    const io = createSocketIoServer(httpServer);
    const provider = createSocketIoProvider(io);
    publish = (channel, type, data) => provider.publish(channel, { type, data });
    closeProvider = () => provider.close!();
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    outsider = (await q(`INSERT INTO mx_users (project_id, external_id, name) VALUES ($1,$2,'Outsider') RETURNING id`, [PROJECT, `${TAG}-out`])).rows[0].id;
    otherOrgId = (await q(`INSERT INTO mx_organizations (name, slug, api_key, api_secret_hash) VALUES ($1,$2,$3,'x') RETURNING id`, [`Other ${TAG}`, `other-${TAG}`, `key-${TAG}`])).rows[0].id;
    otherProjectId = (await q(`INSERT INTO mx_projects (organization_id, name, api_key) VALUES ($1,'Other',$2) RETURNING id`, [otherOrgId, `pkey-${TAG}`])).rows[0].id;
    otherProjectUser = (await q(`INSERT INTO mx_users (project_id, external_id, name) VALUES ($1,$2,'Other user') RETURNING id`, [otherProjectId, `${TAG}-o`])).rows[0].id;
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await q('DELETE FROM mx_users WHERE id = ANY($1)', [[outsider, otherProjectUser]]);
    await q('DELETE FROM mx_projects WHERE id = $1', [otherProjectId]);
    await q('DELETE FROM mx_organizations WHERE id = $1', [otherOrgId]);
    await new Promise<void>((r) => httpServer.close(() => r())).catch(() => {});
    (await import('../../db/pool')).getPool().end();
  });

  const tokenFor = (userId: string, projectId = PROJECT) => sign({ projectId, organizationId: ORG, userId, type: 'user' });

  it('(a) no token -> rejected with AUTH_REQUIRED', async () => {
    const e = await connectError(client(null));
    expect(e.data?.code).toBe('AUTH_REQUIRED');
  });

  it('(b) garbage, wrong-secret and expired tokens -> INVALID_TOKEN', async () => {
    expect((await connectError(client('not.a.jwt'))).data?.code).toBe('INVALID_TOKEN');
    const wrong = jwt.sign({ projectId: PROJECT, userId: USER_IN, type: 'user' }, 'some-other-secret');
    expect((await connectError(client(wrong))).data?.code).toBe('INVALID_TOKEN');
    const expired = sign({ projectId: PROJECT, userId: USER_IN, type: 'user' }, { expiresIn: -10 });
    expect((await connectError(client(expired))).data?.code).toBe('INVALID_TOKEN');
  });

  it('a valid token for an unknown/inactive project -> PROJECT_INACTIVE', async () => {
    const t = sign({ projectId: '00000000-0000-4000-8000-00000000dead', userId: USER_IN, type: 'user' });
    expect((await connectError(client(t))).data?.code).toBe('PROJECT_INACTIVE');
  });

  describe('user rooms (E2EE Stage 7.6)', () => {
    it('a socket auto-joins user:<its own userId> and receives events published there, without joining anything', async () => {
      const mine = client(tokenFor(USER_IN));
      const other = client(tokenFor(outsider));
      await Promise.all([connected(mine), connected(other)]);
      const got = nextEvent(mine, 'device.added');
      const leaked = nextEvent(other, 'device.added');
      await publish(`user:${USER_IN}`, 'device.added', { userId: USER_IN, deviceId: 'd1' });
      expect(await got).toEqual({ userId: USER_IN, deviceId: 'd1' });
      expect(await leaked).toBe('__none__');
    });

    it('every socket of the same user gets it; a token without a userId joins no user room', async () => {
      const a = client(tokenFor(USER_IN));
      const b = client(tokenFor(USER_IN));
      const api = client(sign({ projectId: PROJECT, organizationId: ORG, type: 'api' }));
      await Promise.all([connected(a), connected(b), connected(api)]);
      const ea = nextEvent(a, 'keys.updated');
      const eb = nextEvent(b, 'keys.updated');
      const eapi = nextEvent(api, 'keys.updated');
      await publish(`user:${USER_IN}`, 'keys.updated', { conversationId: CONV, keyVersion: 1, deviceIds: [] });
      expect(await ea).toMatchObject({ keyVersion: 1 });
      expect(await eb).toMatchObject({ keyVersion: 1 });
      expect(await eapi).toBe('__none__');
    });

    it('a client cannot subscribe to a user room through join-conversation', async () => {
      const c = client(tokenFor(outsider));
      await connected(c);
      expect(await join(c, `user:${USER_IN}`)).toEqual({ ok: false, code: 'INVALID_PAYLOAD' });
      const got = nextEvent(c, 'device.added');
      await publish(`user:${USER_IN}`, 'device.added', {});
      expect(await got).toBe('__none__');
    });
  });

  it('(c) a participant joins -> ack ok', async () => {
    const c = client(tokenFor(USER_IN));
    await connected(c);
    expect(await join(c, CONV)).toEqual({ ok: true });
  });

  it('(d) non-participant, other-project user, and api token (no userId) -> FORBIDDEN', async () => {
    const a = client(tokenFor(outsider));
    await connected(a);
    expect(await join(a, CONV)).toEqual({ ok: false, code: 'FORBIDDEN' });

    // user of ANOTHER project, claiming a conversation of this one
    const b = client(tokenFor(otherProjectUser, otherProjectId));
    await connected(b);
    expect(await join(b, CONV)).toEqual({ ok: false, code: 'FORBIDDEN' });

    const api = client(sign({ projectId: PROJECT, organizationId: ORG, type: 'api' }));
    await connected(api);
    expect(await join(api, CONV)).toEqual({ ok: false, code: 'FORBIDDEN' });

    // an unknown conversation is indistinguishable from a forbidden one
    expect(await join(a, '00000000-0000-4000-8000-00000000ffff')).toEqual({ ok: false, code: 'FORBIDDEN' });
  });

  it('rejects malformed join payloads without touching the database', async () => {
    const c = client(tokenFor(USER_IN));
    await connected(c);
    expect(await join(c, 'not-a-uuid')).toEqual({ ok: false, code: 'INVALID_PAYLOAD' });
    expect(await join(c, undefined)).toEqual({ ok: false, code: 'INVALID_PAYLOAD' });
    expect(await join(c, { $ne: null })).toEqual({ ok: false, code: 'INVALID_PAYLOAD' });
  });

  it('(e)+(f) a published event reaches clients in the room and nobody else', async () => {
    const inRoom = client(tokenFor(USER_IN));
    const notJoined = client(tokenFor(USER_IN));
    const notAllowed = client(tokenFor(outsider));
    await Promise.all([connected(inRoom), connected(notJoined), connected(notAllowed)]);
    expect((await join(inRoom, CONV)).ok).toBe(true);
    await join(notAllowed, CONV); // FORBIDDEN, stays out

    const got = nextEvent(inRoom, 'message.created');
    const gotNotJoined = nextEvent(notJoined, 'message.created');
    const gotNotAllowed = nextEvent(notAllowed, 'message.created');
    await publish(`conversation:${CONV}`, 'message.created', { id: 'm1', content: 'hi' });

    expect(await got).toEqual({ id: 'm1', content: 'hi' });
    expect(await gotNotJoined).toBe('__none__');
    expect(await gotNotAllowed).toBe('__none__');
  });

  it('leave-conversation stops delivery', async () => {
    const c = client(tokenFor(USER_IN));
    await connected(c);
    await join(c, CONV);
    const left = await new Promise<{ ok: boolean }>((res) => c.emit('leave-conversation', { conversationId: CONV }, res));
    expect(left.ok).toBe(true);
    const got = nextEvent(c, 'message.created');
    await publish(`conversation:${CONV}`, 'message.created', { id: 'm2' });
    expect(await got).toBe('__none__');
  });

  it('rate-limits join attempts per socket (RATE_LIMITED after 20 in a window)', async () => {
    const c = client(tokenFor(USER_IN));
    await connected(c);
    const codes: (string | undefined)[] = [];
    for (let i = 0; i < 22; i++) codes.push((await join(c, 'not-a-uuid')).code);
    expect(codes.slice(0, 20).every((x) => x === 'INVALID_PAYLOAD')).toBe(true);
    expect(codes.slice(20)).toEqual(['RATE_LIMITED', 'RATE_LIMITED']);
  });

  it('disconnects a socket when its token expires', async () => {
    const c = client(sign({ projectId: PROJECT, userId: USER_IN, type: 'user' }, { expiresIn: 2 }));
    await connected(c);
    const gone = new Promise<string>((res) => c.once('disconnect', (reason) => res(reason)));
    expect(await gone).toBe('io server disconnect');
  }, 8000);

  it('close() disconnects every client (graceful shutdown)', async () => {
    const c = client(tokenFor(USER_IN));
    await connected(c);
    const gone = new Promise<string>((res) => c.once('disconnect', (reason) => res(reason)));
    await closeProvider();
    expect(['io server disconnect', 'transport close']).toContain(await gone);
    await sleep(10);
  });
});
