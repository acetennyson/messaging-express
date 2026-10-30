/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed socket payloads */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'http';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';

/** Stage 7.7 over real sockets: participant.* events, and a removed user's sockets leaving the conversation room. */
const hasDb = !!process.env.DATABASE_URL;
vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'participants-rt-test-secret';
});

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000a2';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tok = (userId: string) => jwt.sign({ projectId: PROJECT, organizationId: ORG, userId, type: 'user' }, process.env.JWT_SECRET!, { expiresIn: '1h' });

describe.skipIf(!hasDb)('participants: realtime (Stage 7.7)', () => {
  let httpServer: http.Server;
  let url = '';
  let q: typeof import('../db/pool').query;
  let publish: (channel: string, type: string, data: unknown) => Promise<void>;
  let closeProvider: () => Promise<void>;
  const clients: ClientSocket[] = [];
  const users: string[] = [];
  let conv = '';
  let A = '', R = '', N = '';

  const user = async (withDevice = true) => {
    const id = (await q('INSERT INTO mx_users (project_id, name) VALUES ($1,$2) RETURNING id', [PROJECT, 'rt'])).rows[0].id as string;
    users.push(id);
    if (withDevice) await q('INSERT INTO mx_devices (project_id, user_id, public_key, is_primary) VALUES ($1,$2,$3,true)', [PROJECT, id, randomBytes(32).toString('base64url')]);
    return id;
  };
  async function listen(userId: string, joinConv: boolean) {
    const c = connect(url, { auth: { token: tok(userId) }, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(c);
    const got: Array<{ name: string; data: any }> = [];
    for (const n of ['participant.added', 'participant.removed', 'message.created']) c.on(n, (data) => got.push({ name: n, data }));
    await new Promise<void>((res, rej) => (c.once('connect', () => res()), c.once('connect_error', rej)));
    if (joinConv) await new Promise<any>((res) => c.emit('join-conversation', { conversationId: conv }, res));
    await sleep(150);
    return got;
  }
  const call = async (path: string, method: string, url2: string, userId: string, body?: unknown) => {
    const mod: any = await import(path);
    const res: Response = await mod[method](new NextRequest(url2, { method, headers: { authorization: `Bearer ${tok(userId)}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    return res.status;
  };

  beforeAll(async () => {
    process.env.E2EE_ENABLED = 'on';
    q = (await import('../db/pool')).query;
    const { registerRealtime } = await import('../realtime');
    const { createSocketIoServer, createSocketIoProvider } = await import('../realtime/providers/socketio');
    httpServer = http.createServer();
    const provider = createSocketIoProvider(createSocketIoServer(httpServer));
    registerRealtime(provider);
    publish = (c, t, d) => provider.publish(c, { type: t, data: d });
    closeProvider = () => provider.close!();
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    [A, R, N] = [await user(), await user(), await user()];
    conv = (await q(`INSERT INTO mx_conversations (project_id, type, title, encryption_mode) VALUES ($1,'group','rt','e2ee-v1') RETURNING id`, [PROJECT])).rows[0].id;
    for (const u of [A, R]) await q('INSERT INTO mx_conversation_participants (conversation_id, user_id) VALUES ($1,$2)', [conv, u]);
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await q('DELETE FROM mx_conversations WHERE id = $1', [conv]);
    await q('DELETE FROM mx_users WHERE id = ANY($1)', [users]);
    await closeProvider().catch(() => {});
    delete process.env.E2EE_ENABLED;
    (await import('../db/pool')).getPool().end();
  });

  it('add: members and the new user hear participant.added; a stranger does not', async () => {
    const [gA, gR, gN] = [await listen(A, false), await listen(R, false), await listen(N, false)];
    const stranger = await user();
    const gS = await listen(stranger, false);
    expect(await call('../../app/api/v1/conversations/[id]/participants/route', 'POST', `http://localhost/api/v1/conversations/${conv}/participants`, A, { userId: N })).toBe(201);
    await sleep(500);
    for (const g of [gA, gR, gN]) expect(g).toEqual([{ name: 'participant.added', data: { conversationId: conv, userId: N } }]);
    expect(gS).toEqual([]);
    await q('DELETE FROM mx_conversation_participants WHERE conversation_id = $1 AND user_id = $2', [conv, N]);
  });

  it('remove: everyone (including the removed user) hears participant.removed with minKeyVersion, and the removed user stops receiving conversation messages', async () => {
    const [gA, gR] = [await listen(A, true), await listen(R, true)];
    await publish(`conversation:${conv}`, 'message.created', { n: 1 });
    await sleep(300);
    expect(gA.filter((e) => e.name === 'message.created')).toHaveLength(1);
    expect(gR.filter((e) => e.name === 'message.created')).toHaveLength(1);

    expect(await call('../../app/api/v1/conversations/[id]/participants/[userId]/route', 'DELETE', `http://localhost/api/v1/conversations/${conv}/participants/${R}`, A)).toBe(200);
    await sleep(600);
    const removedEvent = { name: 'participant.removed', data: { conversationId: conv, userId: R, minKeyVersion: 1 } };
    expect(gA).toContainEqual(removedEvent);
    expect(gR).toContainEqual(removedEvent);

    await publish(`conversation:${conv}`, 'message.created', { n: 2 });
    await sleep(300);
    expect(gA.filter((e) => e.name === 'message.created')).toHaveLength(2);
    expect(gR.filter((e) => e.name === 'message.created')).toHaveLength(1); // evicted: nothing after removal
  });
});
