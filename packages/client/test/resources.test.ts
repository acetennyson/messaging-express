import { afterEach, describe, expect, it } from 'vitest';
import { createClient, MessagingExpressError } from '../src';
import { json, startMockServer } from './mockServer';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const CONV = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

async function setup(handler: Parameters<typeof startMockServer>[0]) {
  const s = await startMockServer(handler);
  closers.push(s.close);
  return { s, client: createClient({ baseUrl: s.url, token: 'tok' }) };
}
const bodyOf = (r: { body: Buffer }) => JSON.parse(r.body.toString('utf8'));

describe('messages', () => {
  it('send POSTs the JSON body with the bearer token and returns the unwrapped message', async () => {
    const { s, client } = await setup((_r, res) => json(res, 201, { data: { id: 'm1', content: 'hi' } }));
    const msg = await client.messages.send({
      conversationId: CONV,
      senderId: USER,
      content: 'hi',
      attachments: [{ type: 'image', url: 'https://cdn.test/a.png', filename: 'a.png', mimeType: 'image/png', sizeBytes: 10 }],
    });
    expect(msg).toMatchObject({ id: 'm1' });
    const r = s.requests[0];
    expect([r.method, r.url]).toEqual(['POST', '/api/v1/messages']);
    expect(r.headers.authorization).toBe('Bearer tok');
    expect(bodyOf(r)).toMatchObject({ conversationId: CONV, senderId: USER, content: 'hi', attachments: [{ url: 'https://cdn.test/a.png' }] });
  });

  it('send is NEVER retried, even on 503 (no duplicate messages)', async () => {
    const { s, client } = await setup((_r, res) => json(res, 503, { error: { message: 'down', code: 'UNAVAILABLE' } }));
    const err = await client.messages.send({ conversationId: CONV, senderId: USER, content: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(MessagingExpressError);
    expect(err.status).toBe(503);
    expect(s.requests).toHaveLength(1);
  });

  it('send surfaces the server error (404 conversation not found)', async () => {
    const { client } = await setup((_r, res) => json(res, 404, { error: { message: 'Conversation not found', code: 'NOT_FOUND' } }));
    await expect(client.messages.send({ conversationId: CONV, senderId: USER })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('list builds the query string, converts Dates to ISO and drops undefined', async () => {
    const { s, client } = await setup((_r, res) => json(res, 200, { data: [{ id: 'm1' }], meta: { limit: 20, page: 1 } }));
    const page = await client.messages.list({ conversationId: CONV, limit: 20, before: new Date('2026-01-02T03:04:05.000Z'), after: '2026-01-01T00:00:00.000Z', senderId: undefined });
    expect(page).toEqual({ data: [{ id: 'm1' }], meta: { limit: 20, page: 1 } });
    const u = new URL(s.requests[0].url, 'http://x');
    expect(u.pathname).toBe('/api/v1/messages');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      conversationId: CONV,
      limit: '20',
      before: '2026-01-02T03:04:05.000Z',
      after: '2026-01-01T00:00:00.000Z',
    });
  });

  it('list IS retried on a transient failure', async () => {
    let n = 0;
    const { s, client } = await setup((_r, res) => (n++ === 0 ? json(res, 503, { error: { message: 'x' } }) : json(res, 200, { data: [], meta: {} })));
    const page = await client.messages.list({ conversationId: CONV });
    expect(page.data).toEqual([]);
    expect(s.requests).toHaveLength(2);
  });

  it('list always returns data and meta, even if the server omits meta', async () => {
    const { client } = await setup((_r, res) => json(res, 200, { data: [{ id: 'm1' }] }));
    expect(await client.messages.list({ conversationId: CONV })).toEqual({ data: [{ id: 'm1' }], meta: {} });
  });
});

describe('conversations', () => {
  it('create POSTs the body and returns the conversation with participants', async () => {
    const { s, client } = await setup((_r, res) => json(res, 201, { data: { id: CONV, participants: [{ id: USER, role: 'member' }] } }));
    const c = await client.conversations.create({ type: 'group', title: 'Team', participantIds: [USER] });
    expect(c.participants[0].id).toBe(USER);
    expect([s.requests[0].method, s.requests[0].url]).toEqual(['POST', '/api/v1/conversations']);
    expect(bodyOf(s.requests[0])).toEqual({ type: 'group', title: 'Team', participantIds: [USER] });
  });

  it('create is never retried', async () => {
    const { s, client } = await setup((_r, res) => json(res, 502, { error: { message: 'bad gateway' } }));
    await expect(client.conversations.create({ type: 'direct', participantIds: [USER] })).rejects.toMatchObject({ status: 502 });
    expect(s.requests).toHaveLength(1);
  });

  it('list works with no arguments and passes filters through', async () => {
    const { s, client } = await setup((_r, res) => json(res, 200, { data: [], meta: { total: 0, totalPages: 0 } }));
    await client.conversations.list();
    await client.conversations.list({ type: 'support', userId: USER, limit: 5, offset: 10 });
    await client.conversations.list({ isArchived: false });
    await client.conversations.list({ isArchived: true });
    expect(s.requests[0].url).toBe('/api/v1/conversations');
    expect(Object.fromEntries(new URL(s.requests[1].url, 'http://x').searchParams)).toEqual({ type: 'support', userId: USER, limit: '5', offset: '10' });
    // booleans travel as the text the server's schema accepts, and `false` is NOT dropped
    expect(Object.fromEntries(new URL(s.requests[2].url, 'http://x').searchParams)).toEqual({ isArchived: 'false' });
    expect(Object.fromEntries(new URL(s.requests[3].url, 'http://x').searchParams)).toEqual({ isArchived: 'true' });
  });
});

describe('users', () => {
  it('upsert POSTs the body and returns the user', async () => {
    const { s, client } = await setup((_r, res) => json(res, 201, { data: { id: USER, external_id: 'ext-1' } }));
    const u = await client.users.upsert({ externalId: 'ext-1', name: 'Ada', email: 'ada@example.com' });
    expect(u).toMatchObject({ id: USER, external_id: 'ext-1' });
    expect([s.requests[0].method, s.requests[0].url]).toEqual(['POST', '/api/v1/users']);
    expect(bodyOf(s.requests[0])).toEqual({ externalId: 'ext-1', name: 'Ada', email: 'ada@example.com' });
  });

  it('upsert is never retried', async () => {
    const { s, client } = await setup((_r, res) => json(res, 504, { error: { message: 'timeout' } }));
    await expect(client.users.upsert({ externalId: 'e', name: 'A' })).rejects.toMatchObject({ status: 504 });
    expect(s.requests).toHaveLength(1);
  });

  it('list passes search and externalId', async () => {
    const { s, client } = await setup((_r, res) => json(res, 200, { data: [{ id: USER }], meta: { total: 9, totalPages: 1, limit: 50, page: 1 } }));
    const page = await client.users.list({ search: 'ad', externalId: 'ext-1' });
    expect(page.meta.total).toBe(9);
    expect(Object.fromEntries(new URL(s.requests[0].url, 'http://x').searchParams)).toEqual({ search: 'ad', externalId: 'ext-1' });
  });
});
