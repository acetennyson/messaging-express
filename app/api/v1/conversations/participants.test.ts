/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers read loosely-typed JSON responses */
import { afterAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';

/** E2EE Stage 7.7: participants add/remove and server-enforced min_key_version. Real Postgres + smoke seed; skipped without DATABASE_URL. */
const hasDb = !!process.env.DATABASE_URL;
vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'participants-test-secret';
});
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000a2';
const pubKey = () => randomBytes(32).toString('base64url');
const wrapped = () => randomBytes(73).toString('base64url');
const ciphertext = () => Buffer.concat([Buffer.from([1]), randomBytes(59)]).toString('base64url');
const tok = (userId?: string, type: 'user' | 'api' | 'admin' = userId ? 'user' : 'api', projectId = PROJECT) =>
  jwt.sign({ projectId, organizationId: ORG, type, ...(userId && { userId }) }, process.env.JWT_SECRET!, { expiresIn: '1h' });

type Res = { status: number; json: any };
async function http(handlerPath: string, method: string, url: string, token: string, opts: { device?: string; body?: unknown } = {}): Promise<Res> {
  const mod: any = await import(handlerPath);
  const res: Response = await mod[method](
    new NextRequest(url, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.device ? { 'x-device-id': opts.device } : {}) },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })
  );
  return { status: res.status, json: await res.json() };
}
const base = 'http://localhost/api/v1/conversations';
const addP = (conv: string, token: string, userId: unknown) => http('./[id]/participants/route', 'POST', `${base}/${conv}/participants`, token, { body: { userId } });
const delP = (conv: string, token: string, userId: string) => http('./[id]/participants/[userId]/route', 'DELETE', `${base}/${conv}/participants/${userId}`, token);
const upload = (conv: string, userId: string, device: string, keyVersion: number, devices: string[]) =>
  http('./[id]/keys/route', 'POST', `${base}/${conv}/keys`, tok(userId), { device, body: { keyVersion, keys: devices.map((d) => ({ deviceId: d, wrappedKey: wrapped(), wrappedByDeviceId: device })) } });
const sendMsg = (conv: string, userId: string, keyVersion: number) =>
  http('../messages/route', 'POST', 'http://localhost/api/v1/messages', tok(userId), {
    body: { conversationId: conv, senderId: userId, content: ciphertext(), metadata: { scheme: 'ck-xchacha-v1', key_version: keyVersion } },
  });

describe.skipIf(!hasDb)('conversation participants (Stage 7.7)', () => {
  const users: string[] = [];
  const convs: string[] = [];
  let query: typeof import('@/lib/db/pool').query;
  const setup = async () => {
    query = (await import('@/lib/db/pool')).query;
  };
  type U = { id: string; dev: string | null };
  const newUser = async (withDevice = true): Promise<U> => {
    await setup();
    const id = (await query('INSERT INTO mx_users (project_id, name) VALUES ($1,$2) RETURNING id', [PROJECT, 'part'])).rows[0].id as string;
    users.push(id);
    const dev = withDevice
      ? ((await query('INSERT INTO mx_devices (project_id, user_id, public_key, is_primary) VALUES ($1,$2,$3,true) RETURNING id', [PROJECT, id, pubKey()])).rows[0].id as string)
      : null;
    return { id, dev };
  };
  /** An e2ee conversation with these members and key version 1 for each member's device. */
  const secureConv = async (members: U[]): Promise<string> => {
    process.env.E2EE_ENABLED = 'on';
    const id = (await query(`INSERT INTO mx_conversations (project_id, type, title, encryption_mode) VALUES ($1,'group','p','e2ee-v1') RETURNING id`, [PROJECT])).rows[0].id as string;
    convs.push(id);
    for (const m of members) {
      await query('INSERT INTO mx_conversation_participants (conversation_id, user_id) VALUES ($1,$2)', [id, m.id]);
      await query('INSERT INTO mx_conversation_keys (conversation_id, device_id, key_version, wrapped_key, wrapped_by_device_id) VALUES ($1,$2,1,$3,$2)', [id, m.dev, wrapped()]);
    }
    return id;
  };
  const plainConv = async (members: U[]): Promise<string> => {
    const id = (await query(`INSERT INTO mx_conversations (project_id, type, title) VALUES ($1,'group','p') RETURNING id`, [PROJECT])).rows[0].id as string;
    convs.push(id);
    for (const m of members) await query('INSERT INTO mx_conversation_participants (conversation_id, user_id) VALUES ($1,$2)', [id, m.id]);
    return id;
  };
  const members = async (conv: string) => (await query('SELECT user_id FROM mx_conversation_participants WHERE conversation_id = $1', [conv])).rows.map((r) => r.user_id as string).sort();
  const minKv = async (conv: string) => (await query('SELECT min_key_version FROM mx_conversations WHERE id = $1', [conv])).rows[0].min_key_version as number;

  afterAll(async () => {
    if (!query) return;
    // Messages first: mx_messages.sender_id is NOT NULL but its FK is ON DELETE SET NULL, so a user with messages cannot be deleted.
    await query('DELETE FROM mx_messages WHERE conversation_id = ANY($1) OR sender_id = ANY($2)', [convs, users]);
    await query('DELETE FROM mx_conversations WHERE id = ANY($1)', [convs]);
    await query('DELETE FROM mx_users WHERE id = ANY($1)', [users]);
    delete process.env.E2EE_ENABLED;
    (await import('@/lib/db/pool')).getPool().end();
  });

  describe('add', () => {
    it('a participant adds a user (201), repeating is a no-op (200); admin/api tokens may add too', async () => {
      const [a, b, c] = [await newUser(), await newUser(), await newUser()];
      const conv = await plainConv([a]);
      const r1 = await addP(conv, tok(a.id), b.id);
      expect(r1.status).toBe(201);
      expect(r1.json.data).toEqual({ conversationId: conv, userId: b.id });
      expect((await addP(conv, tok(a.id), b.id)).status).toBe(200);
      expect((await addP(conv, tok(), c.id)).status).toBe(201); // api token
      expect(await members(conv)).toEqual([a.id, b.id, c.id].sort());
    });

    it('rejects: non-participant 403, unknown conversation 404, other project\'s user 404, malformed bodies 400', async () => {
      const [a, outsider, b] = [await newUser(), await newUser(), await newUser()];
      const conv = await plainConv([a]);
      expect((await addP(conv, tok(outsider.id), b.id)).status).toBe(403);
      expect((await addP('00000000-0000-4000-8000-00000000dead', tok(a.id), b.id)).status).toBe(404);
      expect((await addP(conv, tok(a.id), '00000000-0000-4000-8000-00000000dead')).status).toBe(404);
      expect((await addP(conv, tok(a.id), 'not-a-uuid')).status).toBe(400);
      expect((await addP(conv, tok(a.id), undefined)).status).toBe(400);
      expect(await members(conv)).toEqual([a.id]);
      // a token of another project cannot see this conversation at all
      expect((await addP(conv, tok(a.id, 'user', '00000000-0000-4000-8000-0000000000ff'), b.id)).status).not.toBe(201);
    });

    it('e2ee: the new member must already have a device (409 PARTICIPANT_HAS_NO_DEVICE); plain conversations do not care', async () => {
      const [a, nodev] = [await newUser(), await newUser(false)];
      const secure = await secureConv([a]);
      const r = await addP(secure, tok(a.id), nodev.id);
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('PARTICIPANT_HAS_NO_DEVICE');
      expect(r.json.error.details.userIds).toEqual([nodev.id]);
      expect(await members(secure)).toEqual([a.id]);
      expect((await addP(await plainConv([a]), tok(a.id), nodev.id)).status).toBe(201);
    });

    it('e2ee: adding does not change min_key_version; the new member\'s device then receives the current key through a normal upload', async () => {
      const [a, b] = [await newUser(), await newUser()];
      const conv = await secureConv([a]);
      expect((await addP(conv, tok(a.id), b.id)).status).toBe(201);
      expect(await minKv(conv)).toBe(1);
      expect((await upload(conv, a.id, a.dev!, 1, [b.dev!])).status).toBe(201);
    });
  });

  describe('remove', () => {
    it('e2ee: raises min_key_version to max+1; old-version messages are refused, a rotation excluding the removed user unblocks sending', async () => {
      const [a, b, c] = [await newUser(), await newUser(), await newUser()];
      const conv = await secureConv([a, b, c]);
      expect((await sendMsg(conv, a.id, 1)).status).toBe(201);

      const r = await delP(conv, tok(a.id), c.id);
      expect(r.status).toBe(200);
      expect(r.json.data).toEqual({ conversationId: conv, userId: c.id, minKeyVersion: 2 });
      expect(await minKv(conv)).toBe(2);
      expect(await members(conv)).toEqual([a.id, b.id].sort());

      const refused = await sendMsg(conv, a.id, 1);
      expect(refused.status).toBe(409);
      expect(refused.json.error.code).toBe('KEY_ROTATION_REQUIRED');
      expect(refused.json.error.details.minKeyVersion).toBe(2);

      // version 2 including the removed user's device is rejected, and nothing is stored
      const bad = await upload(conv, a.id, a.dev!, 2, [a.dev!, b.dev!, c.dev!]);
      expect(bad.status).toBe(409);
      expect(bad.json.error.code).toBe('STALE_DEVICE_SET');
      expect((await query('SELECT 1 FROM mx_conversation_keys WHERE conversation_id = $1 AND key_version = 2', [conv])).rows).toHaveLength(0);

      expect((await upload(conv, a.id, a.dev!, 2, [a.dev!, b.dev!])).status).toBe(201);
      expect((await sendMsg(conv, b.id, 2)).status).toBe(201);
    });

    it('removing again is 404 and does not bump again; the bump never goes backwards', async () => {
      const [a, b, c] = [await newUser(), await newUser(), await newUser()];
      const conv = await secureConv([a, b, c]);
      expect((await delP(conv, tok(a.id), c.id)).status).toBe(200);
      expect((await delP(conv, tok(a.id), c.id)).status).toBe(404);
      expect(await minKv(conv)).toBe(2);
      // two removals before anyone rotates still need only ONE new version
      expect((await delP(conv, tok(a.id), b.id)).json.data.minKeyVersion).toBe(2);
      // after a rotation to v2, the next removal moves the floor to 3
      const d = await newUser();
      await query('INSERT INTO mx_conversation_participants (conversation_id, user_id) VALUES ($1,$2)', [conv, d.id]);
      expect((await upload(conv, a.id, a.dev!, 2, [a.dev!, d.dev!])).status).toBe(201);
      expect((await delP(conv, tok(a.id), d.id)).json.data.minKeyVersion).toBe(3);
    });

    it('a user may remove themselves; a non-participant user token may not (403), an admin token may', async () => {
      const [a, b, outsider] = [await newUser(), await newUser(), await newUser()];
      const conv = await secureConv([a, b]);
      expect((await delP(conv, tok(outsider.id), a.id)).status).toBe(403);
      expect((await delP(conv, tok(a.id), a.id)).status).toBe(200); // leaves
      expect((await delP(conv, tok(undefined, 'admin'), b.id)).status).toBe(200);
      expect(await members(conv)).toEqual([]);
    });

    it('plain conversation: only the row is removed (minKeyVersion null), no key bookkeeping', async () => {
      const [a, b] = [await newUser(), await newUser()];
      const conv = await plainConv([a, b]);
      const r = await delP(conv, tok(a.id), b.id);
      expect(r.json.data).toEqual({ conversationId: conv, userId: b.id, minKeyVersion: null });
      expect(await minKv(conv)).toBe(1);
    });

    it('is keyed on the conversation, not the flag: with E2EE_ENABLED=off an e2ee conversation still gets its floor raised', async () => {
      const [a, b] = [await newUser(), await newUser()];
      const conv = await secureConv([a, b]);
      process.env.E2EE_ENABLED = 'off';
      expect((await delP(conv, tok(a.id), b.id)).json.data.minKeyVersion).toBe(2);
      process.env.E2EE_ENABLED = 'on';
    });

    it('malformed ids are 404 and change nothing', async () => {
      const a = await newUser();
      const conv = await secureConv([a]);
      expect((await delP(conv, tok(a.id), 'nope')).status).toBe(404);
      expect((await delP('nope', tok(a.id), a.id)).status).toBe(404);
      expect(await members(conv)).toEqual([a.id]);
    });
  });

  describe('concurrency', () => {
    it('two members uploading the next version at once: exactly one wins, the other gets KEY_EXISTS', async () => {
      const [a, b, c] = [await newUser(), await newUser(), await newUser()];
      const conv = await secureConv([a, b, c]);
      await delP(conv, tok(a.id), c.id);
      const rs = await Promise.all([upload(conv, a.id, a.dev!, 2, [a.dev!, b.dev!]), upload(conv, b.id, b.dev!, 2, [a.dev!, b.dev!])]);
      expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(rs.find((r) => r.status === 409)!.json.error.code).toBe('KEY_EXISTS');
    });

    it.each(['add', 'remove', 'remove-plain'] as const)('%s waits for the conversation lock the key-upload route also takes', async (kind) => {
      // add/remove (e2ee) would also queue behind the row through a foreign key or the min_key_version UPDATE; a plain
      // removal does neither, so 'remove-plain' is the case that proves the explicit row lock is really taken.
      const [a, b] = [await newUser(), await newUser()];
      const conv = kind === 'remove-plain' ? await plainConv([a, b]) : await secureConv([a, b]);
      const joiner = await newUser();
      const { getPool } = await import('@/lib/db/pool');
      const holder = await getPool().connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM mx_conversations WHERE id = $1 FOR UPDATE', [conv]);
        let done = false;
        const call = kind === 'add' ? addP(conv, tok(a.id), joiner.id) : delP(conv, tok(a.id), b.id);
        const pending = call.then((r) => ((done = true), r));
        await new Promise((r) => setTimeout(r, 400));
        expect(done).toBe(false);
        await holder.query('COMMIT');
        expect((await pending).status).toBe(kind === 'add' ? 201 : 200);
      } finally {
        holder.release();
      }
    });
  });
});
