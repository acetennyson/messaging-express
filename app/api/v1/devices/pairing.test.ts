/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers read loosely-typed JSON responses */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import { randomBytes, randomUUID } from 'node:crypto';

/** E2EE Stage 7.3: key-bound pairing, link, admin reset. Real Postgres with the smoke seed; skipped without DATABASE_URL. */
const hasDb = !!process.env.DATABASE_URL;
vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'pairing-route-test-secret';
});
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000a2';
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000b3';

const pubKey = () => randomBytes(32).toString('base64url');
const tokenFor = (opts: { userId?: string; type?: 'user' | 'api' | 'admin'; projectId?: string } = {}) =>
  jwt.sign(
    { projectId: opts.projectId ?? PROJECT, organizationId: ORG, type: opts.type ?? (opts.userId ? 'user' : 'api'), ...(opts.userId && { userId: opts.userId }) },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  );

async function post(kind: 'pair' | 'link' | 'reset', opts: { path?: string; userId?: string; type?: 'user' | 'api' | 'admin'; body?: unknown; device?: string; projectId?: string } = {}) {
  const mod =
    kind === 'pair' ? await import('./pair/route') : kind === 'link' ? await import('./link/route') : await import('../users/[userId]/devices/reset/route');
  const url = kind === 'reset' ? `http://localhost/api/v1/users${opts.path}` : `http://localhost/api/v1/devices/${kind}`;
  const res: Response = await mod.POST(
    new NextRequest(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenFor(opts)}`,
        'content-type': 'application/json',
        ...(opts.device ? { 'x-device-id': opts.device } : {}),
      },
      body: JSON.stringify(opts.body ?? {}),
    })
  );
  return { status: res.status, json: (await res.json()) as { data?: any; error?: { code?: string; message: string } } };
}

describe.skipIf(!hasDb)('pairing, link and reset', () => {
  const users: string[] = [];
  const convs: string[] = [];
  let query: typeof import('@/lib/db/pool').query;

  const newUser = async (project = PROJECT) => {
    const r = await query('INSERT INTO mx_users (project_id, name) VALUES ($1, $2) RETURNING id', [project, 'pair-test']);
    users.push(r.rows[0].id);
    return r.rows[0].id as string;
  };
  const addDevice = async (userId: string, opts: { primary?: boolean; revoked?: boolean } = {}) => {
    const key = pubKey();
    const id = (
      await query(
        `INSERT INTO mx_devices (project_id, user_id, public_key, is_primary, revoked_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [PROJECT, userId, key, !!opts.primary, opts.revoked ? new Date() : null]
      )
    ).rows[0].id as string;
    return { id, key };
  };
  /** A user with a primary device; returns what the tests need. */
  const userWithPrimary = async () => {
    const userId = await newUser();
    const primary = await addDevice(userId, { primary: true });
    return { userId, primary };
  };
  const approve = (u: { userId: string; primary: { id: string } }, publicKey: string) =>
    post('pair', { userId: u.userId, device: u.primary.id, body: { publicKey } });

  beforeAll(async () => {
    ({ query } = await import('@/lib/db/pool'));
    await query(`INSERT INTO mx_projects (id, organization_id, name, api_key) VALUES ($1, $2, 'Other Project 3', 'smoke-other-project-key-3') ON CONFLICT DO NOTHING`, [OTHER_PROJECT, ORG]);
  });
  afterEach(() => {
    delete process.env.E2EE_ENABLED;
    delete process.env.MAX_DEVICES_PER_USER;
    delete process.env.PAIRING_TTL_SECONDS;
  });
  afterAll(async () => {
    if (convs.length) await query('DELETE FROM mx_conversations WHERE id = ANY($1::uuid[])', [convs]);
    if (users.length) await query('DELETE FROM mx_users WHERE id = ANY($1::uuid[])', [users]);
    await query('DELETE FROM mx_projects WHERE id = $1', [OTHER_PROJECT]);
    const { closePool } = await import('@/lib/db/pool');
    await closePool();
  });

  it('flag off: all three routes are 404 and write nothing', async () => {
    const u = await userWithPrimary();
    const k = pubKey();
    expect((await post('pair', { userId: u.userId, device: u.primary.id, body: { publicKey: k } })).status).toBe(404);
    expect((await post('link', { userId: u.userId, body: { publicKey: k } })).status).toBe(404);
    expect((await post('reset', { path: `/${u.userId}/devices/reset` })).status).toBe(404);
    expect((await query('SELECT 1 FROM mx_pairing_requests WHERE user_id = $1', [u.userId])).rows).toHaveLength(0);
    expect((await query('SELECT 1 FROM mx_devices WHERE user_id = $1 AND revoked_at IS NOT NULL', [u.userId])).rows).toHaveLength(0);
  });

  describe('flag on', () => {
    const on = () => {
      process.env.E2EE_ENABLED = 'on';
    };

    describe('POST /devices/pair', () => {
      it('the primary approves a key; the approval expires after PAIRING_TTL_SECONDS', async () => {
        on();
        process.env.PAIRING_TTL_SECONDS = '90';
        const u = await userWithPrimary();
        const before = Date.now();
        const r = await approve(u, pubKey());
        expect(r.status).toBe(200);
        const ms = new Date(r.json.data.expiresAt).getTime() - before;
        expect(ms).toBeGreaterThan(85_000);
        expect(ms).toBeLessThan(95_000);
      });

      it('needs a device, and that device must be the primary', async () => {
        on();
        const u = await userWithPrimary();
        const companion = await addDevice(u.userId);
        const noHeader = await post('pair', { userId: u.userId, body: { publicKey: pubKey() } });
        expect([noHeader.status, noHeader.json.error?.code]).toEqual([403, 'DEVICE_REQUIRED']);
        const byCompanion = await post('pair', { userId: u.userId, device: companion.id, body: { publicKey: pubKey() } });
        expect([byCompanion.status, byCompanion.json.error?.code]).toEqual([403, 'FORBIDDEN']);
        const noUser = await post('pair', { body: { publicKey: pubKey() } });
        expect(noUser.status).toBe(403);
        expect((await query('SELECT 1 FROM mx_pairing_requests WHERE user_id = $1', [u.userId])).rows).toHaveLength(0);
      });

      it('rejects a bad key, and a key that already belongs to an active device', async () => {
        on();
        const u = await userWithPrimary();
        expect((await approve(u, 'short')).status).toBe(400);
        const dup = await approve(u, u.primary.key);
        expect([dup.status, dup.json.error?.code]).toEqual([400, 'VALIDATION_ERROR']);
      });

      it('keeps only one live approval per user', async () => {
        on();
        const u = await userWithPrimary();
        const k1 = pubKey();
        const k2 = pubKey();
        await approve(u, k1);
        await approve(u, k2);
        const rows = await query('SELECT public_key FROM mx_pairing_requests WHERE user_id = $1', [u.userId]);
        expect(rows.rows).toEqual([{ public_key: k2 }]);
        // approving the same key again just extends it
        expect((await approve(u, k2)).status).toBe(200);
        expect((await query('SELECT 1 FROM mx_pairing_requests WHERE user_id = $1', [u.userId])).rows).toHaveLength(1);
      });

      it('refuses when the user is already at MAX_DEVICES_PER_USER', async () => {
        on();
        process.env.MAX_DEVICES_PER_USER = '1';
        const u = await userWithPrimary();
        const r = await approve(u, pubKey());
        expect([r.status, r.json.error?.code]).toEqual([409, 'DEVICE_LIMIT']);
      });
    });

    describe('POST /devices/link', () => {
      it('links only after approval, returns the other devices and the e2ee conversations, and cannot be replayed', async () => {
        on();
        const u = await userWithPrimary();
        const other = await addDevice(u.userId);
        // an e2ee conversation and a plain one, both with this user
        const c1 = (await query(`INSERT INTO mx_conversations (project_id, type, encryption_mode) VALUES ($1,'group','e2ee-v1') RETURNING id`, [PROJECT])).rows[0].id;
        const c2 = (await query(`INSERT INTO mx_conversations (project_id, type) VALUES ($1,'group') RETURNING id`, [PROJECT])).rows[0].id;
        convs.push(c1, c2);
        for (const c of [c1, c2]) await query('INSERT INTO mx_conversation_participants (conversation_id, user_id) VALUES ($1,$2)', [c, u.userId]);

        const key = pubKey();
        const early = await post('link', { userId: u.userId, body: { publicKey: key } });
        expect([early.status, early.json.error?.code]).toEqual([404, 'PAIRING_NOT_FOUND']);

        await approve(u, key);
        const ok = await post('link', { userId: u.userId, body: { publicKey: key, deviceName: 'Phone' } });
        expect(ok.status).toBe(201);
        expect(ok.json.data.isPrimary).toBe(false);
        expect(ok.json.data.devices.map((d: any) => d.id).sort()).toEqual([u.primary.id, other.id].sort());
        expect(ok.json.data.conversationIds).toEqual([c1]);
        const row = await query('SELECT public_key, is_primary, device_name FROM mx_devices WHERE id = $1', [ok.json.data.id]);
        expect(row.rows[0]).toEqual({ public_key: key, is_primary: false, device_name: 'Phone' });

        const replay = await post('link', { userId: u.userId, body: { publicKey: key } });
        expect([replay.status, replay.json.error?.code]).toEqual([404, 'PAIRING_NOT_FOUND']);
      });

      it('an approval for one key cannot be used to link a different key', async () => {
        on();
        const u = await userWithPrimary();
        await approve(u, pubKey());
        const r = await post('link', { userId: u.userId, body: { publicKey: pubKey() } });
        expect([r.status, r.json.error?.code]).toEqual([404, 'PAIRING_NOT_FOUND']);
        expect((await query('SELECT 1 FROM mx_devices WHERE user_id = $1', [u.userId])).rows).toHaveLength(1);
      });

      it("another user's approval is no use to me, and an expired approval is dead", async () => {
        on();
        const a = await userWithPrimary();
        const b = await userWithPrimary();
        const key = pubKey();
        await approve(a, key);
        expect((await post('link', { userId: b.userId, body: { publicKey: key } })).status).toBe(404);
        await query(`UPDATE mx_pairing_requests SET expires_at = NOW() - interval '1 second' WHERE user_id = $1`, [a.userId]);
        expect((await post('link', { userId: a.userId, body: { publicKey: key } })).status).toBe(404);
      });

      it('validates the body and needs a user token', async () => {
        on();
        const u = await userWithPrimary();
        expect((await post('link', { userId: u.userId, body: { publicKey: 'nope' } })).status).toBe(400);
        expect((await post('link', { userId: u.userId, body: { publicKey: pubKey(), deviceName: 'x'.repeat(65) } })).status).toBe(400);
        expect((await post('link', { body: { publicKey: pubKey() } })).status).toBe(403);
        expect((await post('link', { userId: randomUUID(), body: { publicKey: pubKey() } })).status).toBe(404);
      });

      it('device limit: link is refused AND the approval is not used up', async () => {
        on();
        const u = await userWithPrimary();
        const key = pubKey();
        await approve(u, key);
        process.env.MAX_DEVICES_PER_USER = '1'; // lowered after the approval
        const blocked = await post('link', { userId: u.userId, body: { publicKey: key } });
        expect([blocked.status, blocked.json.error?.code]).toEqual([409, 'DEVICE_LIMIT']);
        delete process.env.MAX_DEVICES_PER_USER;
        expect((await post('link', { userId: u.userId, body: { publicKey: key } })).status).toBe(201);
      });

      it('20 simultaneous link calls for one approval: exactly one device is created', async () => {
        on();
        const u = await userWithPrimary();
        const key = pubKey();
        await approve(u, key);
        const results = await Promise.all(Array.from({ length: 20 }, () => post('link', { userId: u.userId, body: { publicKey: key } })));
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        expect(results.filter((r) => r.status === 404)).toHaveLength(19);
        expect((await query('SELECT 1 FROM mx_devices WHERE user_id = $1 AND revoked_at IS NULL', [u.userId])).rows).toHaveLength(2);
      });

      it('revoking the approving device kills its approvals', async () => {
        on();
        const u = await userWithPrimary();
        await addDevice(u.userId); // so the user keeps a device after the primary goes
        const key = pubKey();
        await approve(u, key);
        const del = await import('./[id]/route');
        const res = await del.DELETE(
          new NextRequest(`http://localhost/api/v1/devices/${u.primary.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${tokenFor({ userId: u.userId })}` } })
        );
        expect(res.status).toBe(200);
        expect((await post('link', { userId: u.userId, body: { publicKey: key } })).status).toBe(404);
      });
    });

    describe('POST /users/:userId/devices/reset', () => {
      it('an API or admin token revokes every device and every pending approval', async () => {
        on();
        const u = await userWithPrimary();
        await addDevice(u.userId);
        await approve(u, pubKey());
        const r = await post('reset', { path: `/${u.userId}/devices/reset`, type: 'admin' });
        expect(r.status).toBe(200);
        expect(r.json.data).toEqual({ revoked: 2 });
        expect((await query('SELECT 1 FROM mx_devices WHERE user_id = $1 AND revoked_at IS NULL', [u.userId])).rows).toHaveLength(0);
        expect((await query('SELECT 1 FROM mx_pairing_requests WHERE user_id = $1', [u.userId])).rows).toHaveLength(0);
        // idempotent, and the user can start over with a fresh primary
        expect((await post('reset', { path: `/${u.userId}/devices/reset` })).json.data).toEqual({ revoked: 0 });
        const reg = await (await import('./route')).POST(
          new NextRequest('http://localhost/api/v1/devices', {
            method: 'POST',
            headers: { authorization: `Bearer ${tokenFor({ userId: u.userId })}`, 'content-type': 'application/json' },
            body: JSON.stringify({ publicKey: pubKey() }),
          })
        );
        expect(reg.status).toBe(201);
      });

      it('an end-user token cannot reset, not even its own devices', async () => {
        on();
        const u = await userWithPrimary();
        const r = await post('reset', { path: `/${u.userId}/devices/reset`, userId: u.userId });
        expect([r.status, r.json.error?.code]).toEqual([403, 'FORBIDDEN']);
        expect((await query('SELECT 1 FROM mx_devices WHERE user_id = $1 AND revoked_at IS NULL', [u.userId])).rows).toHaveLength(1);
      });

      it('404 for an unknown user, a malformed id, and a user of another project', async () => {
        on();
        expect((await post('reset', { path: `/${randomUUID()}/devices/reset` })).status).toBe(404);
        expect((await post('reset', { path: '/not-a-uuid/devices/reset' })).status).toBe(404);
        const foreign = await newUser(OTHER_PROJECT);
        expect((await post('reset', { path: `/${foreign}/devices/reset` })).status).toBe(404);
      });
    });
  });
});
