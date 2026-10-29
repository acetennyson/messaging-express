/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers read loosely-typed JSON responses */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import { randomBytes, randomUUID } from 'node:crypto';

/** E2EE Stage 7.2: device registry. Real Postgres with the smoke seed; skipped without DATABASE_URL. */
const hasDb = !!process.env.DATABASE_URL;
vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'devices-route-test-secret';
});
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000a2';
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000b2';

const pubKey = () => randomBytes(32).toString('base64url');
const tokenFor = (userId?: string, projectId = PROJECT) =>
  jwt.sign({ projectId, organizationId: ORG, type: userId ? 'user' : 'api', ...(userId && { userId }) }, process.env.JWT_SECRET!, {
    expiresIn: '1h',
  });

type Json = { data?: any; error?: { message: string; code?: string; details?: any } };

async function call(method: 'GET' | 'POST' | 'DELETE', path: string, opts: { userId?: string; body?: unknown; headers?: Record<string, string>; projectId?: string } = {}) {
  const mod = path.startsWith('/') ? await import('./[id]/route') : await import('./route');
  const handler = (mod as any)[method];
  const res: Response = await handler(
    new NextRequest(`http://localhost/api/v1/devices${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokenFor(opts.userId, opts.projectId)}`,
        'content-type': 'application/json',
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })
  );
  return { status: res.status, json: (await res.json()) as Json };
}

describe.skipIf(!hasDb)('devices routes', () => {
  const created: string[] = [];
  let query: typeof import('@/lib/db/pool').query;

  async function newUser(project = PROJECT) {
    const r = await query('INSERT INTO mx_users (project_id, name) VALUES ($1, $2) RETURNING id', [project, 'dev-test']);
    created.push(r.rows[0].id);
    return r.rows[0].id as string;
  }
  const addDevice = async (userId: string, opts: { primary?: boolean; revoked?: boolean; project?: string } = {}) =>
    (
      await query(
        `INSERT INTO mx_devices (project_id, user_id, public_key, is_primary, revoked_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [opts.project ?? PROJECT, userId, pubKey(), !!opts.primary, opts.revoked ? new Date() : null]
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    ({ query } = await import('@/lib/db/pool'));
    await query(
      `INSERT INTO mx_projects (id, organization_id, name, api_key) VALUES ($1, $2, 'Other Project', 'smoke-other-project-key') ON CONFLICT DO NOTHING`,
      [OTHER_PROJECT, ORG]
    );
  });
  afterEach(() => {
    delete process.env.E2EE_ENABLED;
  });
  afterAll(async () => {
    if (created.length) await query('DELETE FROM mx_users WHERE id = ANY($1::uuid[])', [created]);
    await query('DELETE FROM mx_projects WHERE id = $1', [OTHER_PROJECT]);
    const { closePool } = await import('@/lib/db/pool');
    await closePool();
  });

  describe('flag off (default)', () => {
    it('every route is 404 NOT_FOUND and nothing is written', async () => {
      const userId = await newUser();
      const post = await call('POST', '', { userId, body: { publicKey: pubKey() } });
      expect(post.status).toBe(404);
      expect(post.json.error?.code).toBe('NOT_FOUND');
      expect((await call('GET', `?userIds=${userId}`, { userId })).status).toBe(404);
      expect((await call('DELETE', `/${randomUUID()}`, { userId })).status).toBe(404);
      const rows = await query('SELECT 1 FROM mx_devices WHERE user_id = $1', [userId]);
      expect(rows.rows).toHaveLength(0);
    });

    it('an unauthenticated request is still 401, not 404', async () => {
      const route = await import('./route');
      const res = await route.POST(new NextRequest('http://localhost/api/v1/devices', { method: 'POST', body: '{}' }));
      expect(res.status).toBe(401);
    });
  });

  describe('flag on', () => {
    const on = () => {
      process.env.E2EE_ENABLED = 'on';
    };

    it('registers the first device as primary, then 409 DEVICE_EXISTS', async () => {
      on();
      const userId = await newUser();
      const first = await call('POST', '', { userId, body: { publicKey: pubKey(), deviceName: 'Laptop' } });
      expect(first.status).toBe(201);
      expect(first.json.data).toMatchObject({ isPrimary: true });
      expect(first.json.data.id).toMatch(/^[0-9a-f-]{36}$/);

      const second = await call('POST', '', { userId, body: { publicKey: pubKey() } });
      expect(second.status).toBe(409);
      expect(second.json.error?.code).toBe('DEVICE_EXISTS');
    });

    it('validates the body and the token', async () => {
      on();
      const userId = await newUser();
      for (const publicKey of ['short', 'A'.repeat(43) + '!', 'A'.repeat(44), '', 123]) {
        const r = await call('POST', '', { userId, body: { publicKey } });
        expect(r.status, String(publicKey)).toBe(400);
        expect(r.json.error?.code).toBe('VALIDATION_ERROR');
      }
      expect((await call('POST', '', { userId, body: { publicKey: pubKey(), deviceName: 'x'.repeat(65) } })).status).toBe(400);
      // a token without a user cannot own devices
      const noUser = await call('POST', '', { body: { publicKey: pubKey() } });
      expect(noUser.status).toBe(403);
      expect(noUser.json.error?.code).toBe('FORBIDDEN');
      // a user id that does not exist in this project
      const ghost = await call('POST', '', { userId: randomUUID(), body: { publicKey: pubKey() } });
      expect(ghost.status).toBe(404);
      // a user from another project cannot register through this project's token
      const foreign = await newUser(OTHER_PROJECT);
      expect((await call('POST', '', { userId: foreign, body: { publicKey: pubKey() } })).status).toBe(404);
    });

    it('concurrent first registrations yield exactly one primary', async () => {
      on();
      const userId = await newUser();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => call('POST', '', { userId, body: { publicKey: pubKey() } }))
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(7);
      const rows = await query('SELECT is_primary FROM mx_devices WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      expect(rows.rows).toEqual([{ is_primary: true }]);
    });

    it('a user whose only device was revoked can register again', async () => {
      on();
      const userId = await newUser();
      const first = await call('POST', '', { userId, body: { publicKey: pubKey() } });
      expect((await call('DELETE', `/${first.json.data.id}`, { userId })).status).toBe(200);
      const again = await call('POST', '', { userId, body: { publicKey: pubKey() } });
      expect(again.status).toBe(201);
      expect(again.json.data.isPrimary).toBe(true);
    });

    describe('GET /devices', () => {
      it('lists active devices only, scoped to the project', async () => {
        on();
        const a = await newUser();
        const b = await newUser();
        const foreign = await newUser(OTHER_PROJECT);
        const da = await addDevice(a, { primary: true });
        const db1 = await addDevice(b, { primary: true });
        await addDevice(b, { revoked: true });
        await addDevice(foreign, { primary: true, project: OTHER_PROJECT });

        const r = await call('GET', `?userIds=${a},${b},${foreign}`, { userId: a });
        expect(r.status).toBe(200);
        expect(r.json.data.map((d: any) => d.id).sort()).toEqual([da, db1].sort());
        expect(Object.keys(r.json.data[0]).sort()).toEqual(['deviceName', 'id', 'isPrimary', 'publicKey', 'userId']);
        // the same query from the other project's token sees only its own user
        const other = await call('GET', `?userIds=${a},${foreign}`, { userId: foreign, projectId: OTHER_PROJECT });
        expect(other.json.data.map((d: any) => d.userId)).toEqual([foreign]);
      });

      it('rejects a missing list, bad ids, and more than 50 ids; de-duplicates; unknown ids yield nothing', async () => {
        on();
        const a = await newUser();
        expect((await call('GET', '', { userId: a })).status).toBe(400);
        expect((await call('GET', '?userIds=', { userId: a })).status).toBe(400);
        expect((await call('GET', '?userIds=not-a-uuid', { userId: a })).status).toBe(400);
        const many = Array.from({ length: 51 }, () => randomUUID()).join(',');
        expect((await call('GET', `?userIds=${many}`, { userId: a })).status).toBe(400);
        const fifty = Array.from({ length: 50 }, () => randomUUID()).join(',');
        expect((await call('GET', `?userIds=${fifty}`, { userId: a })).json.data).toEqual([]);
        await addDevice(a, { primary: true });
        expect((await call('GET', `?userIds=${a},${a}`, { userId: a })).json.data).toHaveLength(1);
      });

      it('needs a user token', async () => {
        on();
        expect((await call('GET', `?userIds=${randomUUID()}`)).status).toBe(403);
      });
    });

    describe('DELETE /devices/:id', () => {
      it('revokes an own device; a second revoke and unknown ids are 404', async () => {
        on();
        const userId = await newUser();
        const d1 = await addDevice(userId, { primary: true });
        const r = await call('DELETE', `/${d1}`, { userId });
        expect(r.status).toBe(200);
        expect(r.json.data.id).toBe(d1);
        expect(r.json.data.revokedAt).toBeTruthy();
        expect((await call('DELETE', `/${d1}`, { userId })).status).toBe(404);
        expect((await call('DELETE', `/${randomUUID()}`, { userId })).status).toBe(404);
        expect((await call('DELETE', '/not-a-uuid', { userId })).status).toBe(404);
      });

      it("cannot revoke someone else's device or one from another project", async () => {
        on();
        const owner = await newUser();
        const intruder = await newUser();
        const d = await addDevice(owner, { primary: true });
        expect((await call('DELETE', `/${d}`, { userId: intruder })).status).toBe(404);
        expect((await call('DELETE', `/${d}`, { userId: owner, projectId: OTHER_PROJECT })).status).toBe(404);
        const still = await query('SELECT revoked_at FROM mx_devices WHERE id = $1', [d]);
        expect(still.rows[0].revoked_at).toBeNull();
      });

      it('revoking the primary promotes the oldest remaining active device; revoking a companion changes nothing else', async () => {
        on();
        const userId = await newUser();
        const primary = await addDevice(userId, { primary: true });
        const older = await addDevice(userId);
        const newer = await addDevice(userId);
        await call('DELETE', `/${primary}`, { userId });
        const rows = await query('SELECT id, is_primary FROM mx_devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at, id', [userId]);
        expect(rows.rows).toEqual([
          { id: older, is_primary: true },
          { id: newer, is_primary: false },
        ]);
        await call('DELETE', `/${newer}`, { userId });
        const after = await query('SELECT id, is_primary FROM mx_devices WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
        expect(after.rows).toEqual([{ id: older, is_primary: true }]);
      });

      it('deletes pairing approvals made by the revoked device', async () => {
        on();
        const userId = await newUser();
        const primary = await addDevice(userId, { primary: true });
        await query(
          `INSERT INTO mx_pairing_requests (user_id, public_key, requesting_device_id, expires_at) VALUES ($1, $2, $3, NOW() + interval '1 minute')`,
          [userId, pubKey(), primary]
        );
        await call('DELETE', `/${primary}`, { userId });
        expect((await query('SELECT 1 FROM mx_pairing_requests WHERE user_id = $1', [userId])).rows).toHaveLength(0);
      });
    });
  });
});

describe.skipIf(!hasDb)('requireDevice (X-Device-Id)', () => {
  const created: string[] = [];
  afterAll(async () => {
    const { query, closePool } = await import('@/lib/db/pool');
    if (created.length) await query('DELETE FROM mx_users WHERE id = ANY($1::uuid[])', [created]);
    await closePool();
  });

  const req = (header?: string) =>
    new NextRequest('http://localhost/x', { headers: header === undefined ? {} : { 'x-device-id': header } });
  const ctx = (userId?: string) => ({ projectId: PROJECT, userId, type: 'user' as const });

  it('accepts an active device of the token user, and rejects everything else with the right code', async () => {
    const { query } = await import('@/lib/db/pool');
    const { requireDevice } = await import('@/lib/auth/device');
    const mk = async () => {
      const u = (await query('INSERT INTO mx_users (project_id, name) VALUES ($1, $2) RETURNING id', [PROJECT, 'rd'])).rows[0].id;
      created.push(u);
      return u as string;
    };
    const owner = await mk();
    const other = await mk();
    const dev = (await query(`INSERT INTO mx_devices (project_id, user_id, public_key, is_primary) VALUES ($1,$2,$3,true) RETURNING id`, [PROJECT, owner, pubKey()])).rows[0].id;
    const revoked = (await query(`INSERT INTO mx_devices (project_id, user_id, public_key, revoked_at) VALUES ($1,$2,$3,NOW()) RETURNING id`, [PROJECT, owner, pubKey()])).rows[0].id;

    await expect(requireDevice(req(dev), ctx(owner))).resolves.toEqual({ id: dev, userId: owner, isPrimary: true });
    await expect(requireDevice(req(), ctx(owner))).rejects.toMatchObject({ status: 403, code: 'DEVICE_REQUIRED' });
    await expect(requireDevice(req('  '), ctx(owner))).rejects.toMatchObject({ code: 'DEVICE_REQUIRED' });
    await expect(requireDevice(req('not-a-uuid'), ctx(owner))).rejects.toMatchObject({ status: 403, code: 'DEVICE_INVALID' });
    await expect(requireDevice(req(randomUUID()), ctx(owner))).rejects.toMatchObject({ code: 'DEVICE_INVALID' });
    await expect(requireDevice(req(revoked), ctx(owner))).rejects.toMatchObject({ code: 'DEVICE_INVALID' });
    await expect(requireDevice(req(dev), ctx(other))).rejects.toMatchObject({ code: 'DEVICE_INVALID' });
    await expect(requireDevice(req(dev), { ...ctx(owner), projectId: OTHER_PROJECT })).rejects.toMatchObject({ code: 'DEVICE_INVALID' });
    await expect(requireDevice(req(dev), ctx(undefined))).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});
