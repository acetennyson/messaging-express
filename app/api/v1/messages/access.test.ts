/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers read loosely-typed JSON responses */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

/** Stage 7.12: per-user access on the message and conversation routes. Real Postgres with the smoke seed; skipped without DATABASE_URL. */
const hasDb = !!process.env.DATABASE_URL;
vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'access-test-secret';
});
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } }));

const PROJECT = '00000000-0000-4000-8000-0000000000a2';
const ORG = '00000000-0000-4000-8000-0000000000a1';

const tok = (type: 'api' | 'admin' | 'user', userId?: string) =>
  jwt.sign({ projectId: PROJECT, organizationId: ORG, type, ...(userId && { userId }) }, process.env.JWT_SECRET!, { expiresIn: '1h' });

async function call(kind: 'messages' | 'conversations', method: 'GET' | 'POST', token: string, opts: { qs?: string; body?: unknown } = {}) {
  const mod = kind === 'messages' ? await import('./route') : await import('../conversations/route');
  const res = await (mod as any)[method](
    new NextRequest(`http://localhost/api/v1/${kind}${opts.qs ?? ''}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    })
  );
  return { status: res.status, json: (await res.json()) as any };
}

describe.skipIf(!hasDb)('participant access (7.12)', () => {
  let query: typeof import('@/lib/db/pool').query;
  const users: string[] = [];
  const convs: string[] = [];
  let alice: string, bob: string, eve: string, plain: string, secret: string;

  const mkUser = async (n: string) => {
    const id = (await query('INSERT INTO mx_users (project_id, name) VALUES ($1,$2) RETURNING id', [PROJECT, n])).rows[0].id as string;
    users.push(id);
    return id;
  };
  const mkConv = async (mode: 'none' | 'e2ee-v1', members: string[]) => {
    const id = (await query(`INSERT INTO mx_conversations (project_id, type, encryption_mode) VALUES ($1,'group',$2) RETURNING id`, [PROJECT, mode])).rows[0].id as string;
    convs.push(id);
    for (const m of members) await query('INSERT INTO mx_conversation_participants (conversation_id, user_id) VALUES ($1,$2)', [id, m]);
    return id;
  };
  const ct = () => Buffer.concat([Buffer.from([1]), Buffer.alloc(59, 7)]).toString('base64url');
  const secretMsg = () => ({ conversationId: secret, senderId: alice, content: ct(), metadata: { scheme: 'ck-xchacha-v1', key_version: 1 } });
  const ids = (j: any) => (j.data as any[]).map((c) => c.id);
  const mode = (m?: string) => {
    if (m) process.env.PARTICIPANT_ACCESS_MODE = m;
    else delete process.env.PARTICIPANT_ACCESS_MODE;
  };

  beforeAll(async () => {
    ({ query } = await import('@/lib/db/pool'));
    [alice, bob, eve] = [await mkUser('alice'), await mkUser('bob'), await mkUser('eve')];
    plain = await mkConv('none', [alice, bob]);
    secret = await mkConv('e2ee-v1', [alice, bob]);
    await query(`INSERT INTO mx_messages (conversation_id, sender_id, content, type) VALUES ($1,$2,'hi bob','text')`, [plain, alice]);
    // A key version exists, so a legitimate encrypted send is accepted by the unrelated key checks.
    const dev = (await query(`INSERT INTO mx_devices (project_id, user_id, public_key) VALUES ($1,$2,$3) RETURNING id`, [PROJECT, alice, Buffer.alloc(32, 9).toString('base64url')])).rows[0].id;
    await query(`INSERT INTO mx_conversation_keys (conversation_id, device_id, key_version, wrapped_key) VALUES ($1,$2,1,'x')`, [secret, dev]);
  });
  afterEach(() => {
    delete process.env.E2EE_ENABLED;
    mode();
    warn.mockClear();
  });
  afterAll(async () => {
    await query('DELETE FROM mx_conversations WHERE id = ANY($1::uuid[])', [convs]);
    await query('DELETE FROM mx_users WHERE id = ANY($1::uuid[])', [users]);
    const { closePool } = await import('@/lib/db/pool');
    await closePool();
  });

  describe('layer 1: encrypted conversations (always, once E2EE is on)', () => {
    it('Eve cannot read the messages of an encrypted conversation she is not in', async () => {
      process.env.E2EE_ENABLED = 'on';
      expect((await call('messages', 'GET', tok('user', eve), { qs: `?conversationId=${secret}` })).status).toBe(403);
      expect((await call('messages', 'GET', tok('user', bob), { qs: `?conversationId=${secret}` })).status).toBe(200);
    });
    it('Eve cannot inject ciphertext as Alice, and a member cannot send as someone else', async () => {
      process.env.E2EE_ENABLED = 'on';
      expect((await call('messages', 'POST', tok('user', eve), { body: secretMsg() })).status).toBe(403);
      expect((await call('messages', 'POST', tok('user', bob), { body: secretMsg() })).status).toBe(403);
      const n = (await query('SELECT count(*)::int n FROM mx_messages WHERE conversation_id=$1', [secret])).rows[0].n;
      expect(n).toBe(0);
    });
    it('does not list encrypted conversations to non-members, plain ones are unchanged', async () => {
      process.env.E2EE_ENABLED = 'on';
      const r = await call('conversations', 'GET', tok('user', eve), { qs: '?limit=100' });
      expect(ids(r.json)).not.toContain(secret);
      expect(ids(r.json)).toContain(plain);
      expect(r.json.meta?.total ?? r.json.pagination?.total).toBeDefined();
      const a = await call('conversations', 'GET', tok('user', alice), { qs: '?limit=100' });
      expect(ids(a.json)).toContain(secret);
    });
    it('list total matches the visible rows', async () => {
      process.env.E2EE_ENABLED = 'on';
      const eveAll = await call('conversations', 'GET', tok('user', eve), { qs: '?limit=100' });
      const total = eveAll.json.meta?.total ?? eveAll.json.pagination?.total;
      expect(total).toBe(eveAll.json.data.length);
    });
    it('api and admin tokens are never restricted', async () => {
      process.env.E2EE_ENABLED = 'on';
      for (const t of [tok('api'), tok('admin')]) {
        expect((await call('messages', 'GET', t, { qs: `?conversationId=${secret}` })).status).toBe(200);
        expect((await call("conversations", "GET", t, { qs: "?limit=100" })).status).toBe(200);
      }
      expect((await call('messages', 'POST', tok('api'), { body: secretMsg() })).status).toBe(201);
      await query('DELETE FROM mx_messages WHERE conversation_id=$1', [secret]);
    });
  });

  describe('layer 2: plain conversations, PARTICIPANT_ACCESS_MODE', () => {
    it('off (default, E2EE off): Eve still does everything, exactly as before', async () => {
      expect((await call('messages', 'GET', tok('user', eve), { qs: `?conversationId=${plain}` })).status).toBe(200);
      expect((await call('conversations', 'GET', tok('user', eve), { qs: `?userId=${alice}` })).status).toBe(200);
      expect(warn).not.toHaveBeenCalled();
    });
    it('dry-run: same results, but every call enforce would refuse is logged', async () => {
      mode('dry-run');
      expect((await call('messages', 'GET', tok('user', eve), { qs: `?conversationId=${plain}` })).status).toBe(200);
      expect((await call('conversations', 'GET', tok('user', eve), { qs: `?userId=${alice}` })).status).toBe(200);
      const r = await call('messages', 'POST', tok('user', eve), { body: { conversationId: plain, senderId: alice, content: 'x' } });
      expect(r.status).toBe(201);
      const rules = warn.mock.calls.filter((c) => c[0] === 'participant_access_would_deny').map((c) => c[1].rule);
      expect(rules).toEqual(expect.arrayContaining(['not_participant', 'foreign_listing', 'sender_mismatch']));
      await query(`DELETE FROM mx_messages WHERE conversation_id=$1 AND content='x'`, [plain]);
    });
    it('enforce: Eve is refused on read, on listing someone else, and on sending as someone else', async () => {
      mode('enforce');
      expect((await call('messages', 'GET', tok('user', eve), { qs: `?conversationId=${plain}` })).status).toBe(403);
      expect((await call('conversations', 'GET', tok('user', eve), { qs: `?userId=${alice}` })).status).toBe(403);
      expect((await call('messages', 'POST', tok('user', eve), { body: { conversationId: plain, senderId: alice, content: 'x' } })).status).toBe(403);
    });
    it('enforce: an unfiltered list shows only her own conversations; members work normally', async () => {
      mode('enforce');
      const e = await call('conversations', 'GET', tok('user', eve), { qs: '?limit=100' });
      expect(e.status).toBe(200);
      expect(ids(e.json)).not.toContain(plain);
      const b = await call('conversations', 'GET', tok('user', bob), { qs: '?limit=100' });
      expect(ids(b.json)).toContain(plain);
      expect((await call('messages', 'GET', tok('user', bob), { qs: `?conversationId=${plain}` })).status).toBe(200);
      const s = await call('messages', 'POST', tok('user', bob), { body: { conversationId: plain, senderId: bob, content: 'y' } });
      expect(s.status).toBe(201);
      await query(`DELETE FROM mx_messages WHERE conversation_id=$1 AND content='y'`, [plain]);
    });
    it('enforce: a missing conversation answers like a non-member one (403)', async () => {
      mode('enforce');
      const r = await call('messages', 'GET', tok('user', bob), { qs: '?conversationId=00000000-0000-4000-8000-00000000dead' });
      expect(r.status).toBe(403);
    });
    it('enforce: api and admin tokens are unaffected', async () => {
      mode('enforce');
      for (const t of [tok('api'), tok('admin')]) {
        expect((await call('messages', 'GET', t, { qs: `?conversationId=${plain}` })).status).toBe(200);
        expect((await call('conversations', 'GET', t, { qs: `?userId=${alice}` })).status).toBe(200);
      }
    });
  });
});
