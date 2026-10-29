/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers read loosely-typed JSON responses */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import { randomBytes, randomUUID } from 'node:crypto';

/** E2EE Stage 7.4: encryptionMode, create-with-keys, key routes. Real Postgres with the smoke seed; skipped without DATABASE_URL. */
const hasDb = !!process.env.DATABASE_URL;
vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'e2ee-conv-test-secret';
});
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000a2';

const pubKey = () => randomBytes(32).toString('base64url');
const wrapped = () => randomBytes(73).toString('base64url'); // a v1-sized wrapped key
const tokenFor = (userId?: string) =>
  jwt.sign({ projectId: PROJECT, organizationId: ORG, type: userId ? 'user' : 'api', ...(userId && { userId }) }, process.env.JWT_SECRET!, { expiresIn: '1h' });

type Res = { status: number; json: { data?: any; error?: { code?: string; message: string; details?: any } } };
async function call(kind: 'create' | 'keys' | 'request', method: 'GET' | 'POST', opts: { conv?: string; userId?: string; device?: string; body?: unknown }): Promise<Res> {
  const mod =
    kind === 'create' ? await import('./route') : kind === 'keys' ? await import('./[id]/keys/route') : await import('./[id]/keys/request/route');
  const url =
    kind === 'create' ? 'http://localhost/api/v1/conversations' : `http://localhost/api/v1/conversations/${opts.conv}/keys${kind === 'request' ? '/request' : ''}`;
  const res: Response = await (mod as any)[method](
    new NextRequest(url, {
      method,
      headers: {
        authorization: `Bearer ${tokenFor(opts.userId)}`,
        'content-type': 'application/json',
        ...(opts.device ? { 'x-device-id': opts.device } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(opts.body ?? {}) } : {}),
    })
  );
  return { status: res.status, json: await res.json() };
}

describe.skipIf(!hasDb)('E2EE conversations and keys', () => {
  const users: string[] = [];
  const convs: string[] = [];
  let query: typeof import('@/lib/db/pool').query;
  const on = () => {
    process.env.E2EE_ENABLED = 'on';
  };

  type U = { userId: string; devices: string[] };
  const newUser = async (deviceCount = 1): Promise<U> => {
    const userId = (await query('INSERT INTO mx_users (project_id, name) VALUES ($1, $2) RETURNING id', [PROJECT, 'e2ee-conv'])).rows[0].id as string;
    users.push(userId);
    const devices: string[] = [];
    for (let i = 0; i < deviceCount; i++) devices.push(await addDevice(userId, i === 0));
    return { userId, devices };
  };
  const addDevice = async (userId: string, primary = false) =>
    (await query(`INSERT INTO mx_devices (project_id, user_id, public_key, is_primary) VALUES ($1,$2,$3,$4) RETURNING id`, [PROJECT, userId, pubKey(), primary])).rows[0].id as string;
  const entries = (devs: string[], by: string) => devs.map((deviceId) => ({ deviceId, wrappedKey: wrapped(), wrappedByDeviceId: by }));
  const allDevices = (...us: U[]) => us.flatMap((u) => u.devices);

  /** Create an e2ee conversation as `creator` (device 0) with the given members; returns the conversation id. */
  async function createSecure(creator: U, others: U[]): Promise<string> {
    const r = await call('create', 'POST', {
      userId: creator.userId,
      device: creator.devices[0],
      body: {
        type: 'group',
        title: 'secure',
        participantIds: [creator.userId, ...others.map((o) => o.userId)],
        encryptionMode: 'e2ee-v1',
        keys: entries(allDevices(creator, ...others), creator.devices[0]),
      },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    convs.push(r.json.data.id);
    return r.json.data.id;
  }
  const keyRows = async (conv: string) =>
    (await query('SELECT device_id, key_version, wrapped_by_device_id FROM mx_conversation_keys WHERE conversation_id = $1 ORDER BY key_version', [conv])).rows;

  beforeAll(async () => {
    ({ query } = await import('@/lib/db/pool'));
  });
  afterEach(() => {
    delete process.env.E2EE_ENABLED;
    delete process.env.E2EE_KEYS_MAX_BATCH;
  });
  afterAll(async () => {
    if (convs.length) await query('DELETE FROM mx_conversations WHERE id = ANY($1::uuid[])', [convs]);
    if (users.length) await query('DELETE FROM mx_users WHERE id = ANY($1::uuid[])', [users]);
    const { closePool } = await import('@/lib/db/pool');
    await closePool();
  });

  describe('flag off', () => {
    it('refuses e2ee-v1 and keys, accepts the explicit default, and the plain create still works', async () => {
      const a = await newUser();
      const b = await newUser();
      const title = `off-${randomUUID()}`;
      const secure = await call('create', 'POST', {
        userId: a.userId,
        device: a.devices[0],
        body: { type: 'group', title, participantIds: [a.userId, b.userId], encryptionMode: 'e2ee-v1', keys: entries(allDevices(a, b), a.devices[0]) },
      });
      expect([secure.status, secure.json.error?.code]).toEqual([400, 'VALIDATION_ERROR']);
      const keysOnly = await call('create', 'POST', { body: { type: 'group', title, participantIds: [a.userId], keys: entries(a.devices, a.devices[0]) } });
      expect(keysOnly.status).toBe(400);
      expect((await query('SELECT 1 FROM mx_conversations WHERE title = $1', [title])).rows).toHaveLength(0);

      const none = await call('create', 'POST', { body: { type: 'group', title, participantIds: [a.userId], encryptionMode: 'none' } });
      expect(none.status).toBe(201);
      convs.push(none.json.data.id);
      expect(none.json.data).toMatchObject({ encryption_mode: 'none', min_key_version: 1 });
    });

    it('the key routes are 404', async () => {
      const a = await newUser();
      expect((await call('keys', 'GET', { conv: randomUUID(), userId: a.userId, device: a.devices[0] })).status).toBe(404);
      expect((await call('keys', 'POST', { conv: randomUUID(), userId: a.userId, device: a.devices[0], body: {} })).status).toBe(404);
      expect((await call('request', 'POST', { conv: randomUUID(), userId: a.userId, device: a.devices[0] })).status).toBe(404);
    });
  });

  describe('create with keys', () => {
    it('creates the conversation and one key row per device, atomically', async () => {
      on();
      const a = await newUser(2);
      const b = await newUser();
      const id = await createSecure(a, [b]);
      const row = (await query('SELECT encryption_mode, min_key_version FROM mx_conversations WHERE id = $1', [id])).rows[0];
      expect(row).toEqual({ encryption_mode: 'e2ee-v1', min_key_version: 1 });
      const keys = await keyRows(id);
      expect(keys.map((k) => k.device_id).sort()).toEqual(allDevices(a, b).sort());
      expect(keys.every((k) => k.key_version === 1 && k.wrapped_by_device_id === a.devices[0])).toBe(true);
    });

    it('needs the device header, a creator who is a participant, and keys', async () => {
      on();
      const a = await newUser();
      const b = await newUser();
      const base = { type: 'group', participantIds: [a.userId, b.userId], encryptionMode: 'e2ee-v1' };
      const k = entries(allDevices(a, b), a.devices[0]);
      const noDev = await call('create', 'POST', { userId: a.userId, body: { ...base, keys: k } });
      expect([noDev.status, noDev.json.error?.code]).toEqual([403, 'DEVICE_REQUIRED']);
      const outsider = await call('create', 'POST', { userId: a.userId, device: a.devices[0], body: { ...base, participantIds: [b.userId], keys: k } });
      expect(outsider.status).toBe(400);
      expect((await call('create', 'POST', { userId: a.userId, device: a.devices[0], body: base })).status).toBe(400);
      expect((await call('create', 'POST', { userId: a.userId, device: a.devices[0], body: { ...base, keys: [] } })).status).toBe(400);
      expect((await call('create', 'POST', { userId: a.userId, device: a.devices[0], body: { type: 'group', participantIds: [a.userId], keys: k } })).status).toBe(400);
    });

    it('409 STALE_DEVICE_SET (with the current set) for missing or extra devices, and no conversation row is left', async () => {
      on();
      const a = await newUser();
      const b = await newUser(2);
      const stranger = await newUser();
      const title = `stale-${randomUUID()}`;
      const mk = (devs: string[]) => ({ type: 'group', title, participantIds: [a.userId, b.userId], encryptionMode: 'e2ee-v1', keys: entries(devs, a.devices[0]) });

      const missing = await call('create', 'POST', { userId: a.userId, device: a.devices[0], body: mk([a.devices[0], b.devices[0]]) });
      expect([missing.status, missing.json.error?.code]).toEqual([409, 'STALE_DEVICE_SET']);
      expect([...missing.json.error!.details.deviceIds].sort()).toEqual(allDevices(a, b).sort());

      const extra = await call('create', 'POST', { userId: a.userId, device: a.devices[0], body: mk([...allDevices(a, b), stranger.devices[0]]) });
      expect([extra.status, extra.json.error?.code]).toEqual([409, 'STALE_DEVICE_SET']);
      expect((await query('SELECT 1 FROM mx_conversations WHERE title = $1', [title])).rows).toHaveLength(0);
    });

    it('409 PARTICIPANT_HAS_NO_DEVICE names who', async () => {
      on();
      const a = await newUser();
      const noDevice = await newUser(0);
      const r = await call('create', 'POST', {
        userId: a.userId,
        device: a.devices[0],
        body: { type: 'group', participantIds: [a.userId, noDevice.userId], encryptionMode: 'e2ee-v1', keys: entries(a.devices, a.devices[0]) },
      });
      expect([r.status, r.json.error?.code]).toEqual([409, 'PARTICIPANT_HAS_NO_DEVICE']);
      expect(r.json.error!.details.userIds).toEqual([noDevice.userId]);
    });

    it('rejects wraps not made by the calling device, duplicate targets, bad blobs, and too many entries', async () => {
      on();
      const a = await newUser();
      const b = await newUser();
      const base = { type: 'group', participantIds: [a.userId, b.userId], encryptionMode: 'e2ee-v1' };
      const ok = entries(allDevices(a, b), a.devices[0]);
      const send = (keys: unknown[]) => call('create', 'POST', { userId: a.userId, device: a.devices[0], body: { ...base, keys } });
      expect((await send(entries(allDevices(a, b), b.devices[0]))).status).toBe(400); // wrapped "by" someone else
      expect((await send([...ok, ok[0]])).status).toBe(400); // duplicate target
      expect((await send([{ ...ok[0], wrappedKey: 'short' }, ok[1]])).status).toBe(400);
      expect((await send([{ ...ok[0], wrappedKey: '!'.repeat(80) }, ok[1]])).status).toBe(400);
      process.env.E2EE_KEYS_MAX_BATCH = '1';
      expect((await send(ok)).status).toBe(400);
    });
  });

  describe('GET /conversations/:id/keys', () => {
    it("returns only the calling device's rows with the wrapper's public key", async () => {
      on();
      const a = await newUser(2);
      const b = await newUser();
      const id = await createSecure(a, [b]);
      const r = await call('keys', 'GET', { conv: id, userId: b.userId, device: b.devices[0] });
      expect(r.status).toBe(200);
      expect(r.json.data).toHaveLength(1);
      expect(r.json.data[0]).toMatchObject({ keyVersion: 1, wrappedByDeviceId: a.devices[0] });
      const wrapperKey = (await query('SELECT public_key FROM mx_devices WHERE id = $1', [a.devices[0]])).rows[0].public_key;
      expect(r.json.data[0].wrappedByPublicKey).toBe(wrapperKey);
      expect(Object.keys(r.json.data[0]).sort()).toEqual(['keyVersion', 'wrappedByDeviceId', 'wrappedByPublicKey', 'wrappedKey']);
    });

    it('403 for a non-participant, 404 unknown, 400 for a plain conversation, 403 without a device', async () => {
      on();
      const a = await newUser();
      const b = await newUser();
      const outsider = await newUser();
      const id = await createSecure(a, [b]);
      expect((await call('keys', 'GET', { conv: id, userId: outsider.userId, device: outsider.devices[0] })).status).toBe(403);
      expect((await call('keys', 'GET', { conv: randomUUID(), userId: a.userId, device: a.devices[0] })).status).toBe(404);
      expect((await call('keys', 'GET', { conv: 'not-a-uuid', userId: a.userId, device: a.devices[0] })).status).toBe(404);
      expect((await call('keys', 'GET', { conv: id, userId: a.userId })).json.error?.code).toBe('DEVICE_REQUIRED');
      const plain = (await query(`INSERT INTO mx_conversations (project_id, type) VALUES ($1, 'group') RETURNING id`, [PROJECT])).rows[0].id;
      convs.push(plain);
      await query('INSERT INTO mx_conversation_participants (conversation_id, user_id) VALUES ($1, $2)', [plain, a.userId]);
      expect((await call('keys', 'GET', { conv: plain, userId: a.userId, device: a.devices[0] })).status).toBe(400);
    });
  });

  describe('POST /conversations/:id/keys', () => {
    it('adds a wrap for a new device of a participant; first writer wins', async () => {
      on();
      const a = await newUser();
      const b = await newUser();
      const id = await createSecure(a, [b]);
      const b2 = await addDevice(b.userId);
      const up = await call('keys', 'POST', { conv: id, userId: a.userId, device: a.devices[0], body: { keyVersion: 1, keys: entries([b2], a.devices[0]) } });
      expect([up.status, up.json.data]).toEqual([201, { inserted: 1 }]);
      const again = await call('keys', 'POST', { conv: id, userId: a.userId, device: a.devices[0], body: { keyVersion: 1, keys: entries([b2], a.devices[0]) } });
      expect([again.status, again.json.error?.code]).toEqual([409, 'KEY_EXISTS']);
      // the new device can now fetch it
      const got = await call('keys', 'GET', { conv: id, userId: b.userId, device: b2 });
      expect(got.json.data).toHaveLength(1);
    });

    it("rejects targets that are not active devices of current participants, and wraps by another device", async () => {
      on();
      const a = await newUser();
      const b = await newUser();
      const outsider = await newUser();
      const id = await createSecure(a, [b]);
      const bad = await call('keys', 'POST', { conv: id, userId: a.userId, device: a.devices[0], body: { keyVersion: 1, keys: entries(outsider.devices, a.devices[0]) } });
      expect(bad.status).toBe(400);
      const revoked = await addDevice(b.userId);
      await query('UPDATE mx_devices SET revoked_at = NOW() WHERE id = $1', [revoked]);
      expect((await call('keys', 'POST', { conv: id, userId: a.userId, device: a.devices[0], body: { keyVersion: 1, keys: entries([revoked], a.devices[0]) } })).status).toBe(400);
      expect((await call('keys', 'POST', { conv: id, userId: a.userId, device: a.devices[0], body: { keyVersion: 1, keys: entries([b.devices[0]], b.devices[0]) } })).status).toBe(400);
      expect((await call('keys', 'POST', { conv: id, userId: outsider.userId, device: outsider.devices[0], body: { keyVersion: 1, keys: entries(a.devices, outsider.devices[0]) } })).status).toBe(403);
    });

    it('a new version (rotation) must cover exactly all active devices, cannot skip versions, and the first writer wins', async () => {
      on();
      const a = await newUser();
      const b = await newUser(2);
      const id = await createSecure(a, [b]);
      const post = (version: number, devs: string[], by = a.devices[0]) =>
        call('keys', 'POST', { conv: id, userId: a.userId, device: a.devices[0], body: { keyVersion: version, keys: entries(devs, by) } });

      expect((await post(3, allDevices(a, b))).status).toBe(400); // skips version 2
      const partial = await post(2, [a.devices[0], b.devices[0]]);
      expect([partial.status, partial.json.error?.code]).toEqual([409, 'STALE_DEVICE_SET']);
      expect(await keyRows(id).then((r) => r.filter((k) => k.key_version === 2))).toHaveLength(0);

      const full = await post(2, allDevices(a, b));
      expect([full.status, full.json.data]).toEqual([201, { inserted: 3 }]);
      const loser = await post(2, allDevices(a, b));
      expect([loser.status, loser.json.error?.code]).toEqual([409, 'KEY_EXISTS']);
    });

    it('two members rotating at once: exactly one wins', async () => {
      on();
      const a = await newUser();
      const b = await newUser();
      const id = await createSecure(a, [b]);
      const rotate = (u: U) =>
        call('keys', 'POST', { conv: id, userId: u.userId, device: u.devices[0], body: { keyVersion: 2, keys: entries(allDevices(a, b), u.devices[0]) } });
      const results = await Promise.all([rotate(a), rotate(b), rotate(a), rotate(b)]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409 && r.json.error?.code === 'KEY_EXISTS')).toHaveLength(3);
      expect((await keyRows(id)).filter((k) => k.key_version === 2)).toHaveLength(2);
    });

    it('a removed participant\'s devices can never be targeted', async () => {
      on();
      const a = await newUser();
      const b = await newUser();
      const c = await newUser();
      const id = await createSecure(a, [b, c]);
      await query('DELETE FROM mx_conversation_participants WHERE conversation_id = $1 AND user_id = $2', [id, c.userId]);
      const withRemoved = await call('keys', 'POST', { conv: id, userId: a.userId, device: a.devices[0], body: { keyVersion: 2, keys: entries(allDevices(a, b, c), a.devices[0]) } });
      expect([withRemoved.status, withRemoved.json.error?.code]).toEqual([409, 'STALE_DEVICE_SET']);
      const without = await call('keys', 'POST', { conv: id, userId: a.userId, device: a.devices[0], body: { keyVersion: 2, keys: entries(allDevices(a, b), a.devices[0]) } });
      expect(without.status).toBe(201);
    });
  });

  describe('POST /conversations/:id/keys/request', () => {
    it('202 for a participant device; 403 for an outsider; 400 for a plain conversation', async () => {
      on();
      const a = await newUser();
      const b = await newUser();
      const outsider = await newUser();
      const id = await createSecure(a, [b]);
      const ok = await call('request', 'POST', { conv: id, userId: b.userId, device: b.devices[0], body: { keyVersion: 1 } });
      expect([ok.status, ok.json.data]).toEqual([202, { requested: true }]);
      expect((await call('request', 'POST', { conv: id, userId: b.userId, device: b.devices[0] })).status).toBe(202); // body optional
      expect((await call('request', 'POST', { conv: id, userId: outsider.userId, device: outsider.devices[0] })).status).toBe(403);
      expect((await call('request', 'POST', { conv: id, userId: b.userId })).json.error?.code).toBe('DEVICE_REQUIRED');
    });
  });
});
