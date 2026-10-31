/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers read loosely-typed JSON responses */
import { afterAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';

/** E2EE Stage 7.8: key backup routes. Real Postgres with the smoke seed; skipped without DATABASE_URL. */
const hasDb = !!process.env.DATABASE_URL;
vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'backup-test-secret';
});
const logSpy = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: logSpy }));

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000a2';
const tok = (userId?: string, projectId = PROJECT) =>
  jwt.sign({ projectId, organizationId: ORG, type: userId ? 'user' : 'api', ...(userId && { userId }) }, process.env.JWT_SECRET!, { expiresIn: '1h' });
const kdf = (over: object = {}) => ({ v: 1, alg: 'argon2id', m: 19456, t: 2, p: 1, salt: randomBytes(16).toString('base64url'), ...over });
const blob = (n = 200) => randomBytes(n).toString('base64url');

async function call(method: 'PUT' | 'GET' | 'DELETE', token: string, body?: unknown) {
  const mod: any = await import('./route');
  const res: Response = await mod[method](
    new NextRequest('http://localhost/api/v1/devices/backup', {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
  return { status: res.status, json: await res.json() };
}

describe.skipIf(!hasDb)('key backup (Stage 7.8)', () => {
  const users: string[] = [];
  let query: typeof import('@/lib/db/pool').query;
  const newUser = async () => {
    query = (await import('@/lib/db/pool')).query;
    const id = (await query('INSERT INTO mx_users (project_id, name) VALUES ($1,$2) RETURNING id', [PROJECT, 'backup'])).rows[0].id as string;
    users.push(id);
    return id;
  };
  afterAll(async () => {
    if (!query) return;
    await query('DELETE FROM mx_users WHERE id = ANY($1)', [users]);
    delete process.env.E2EE_ENABLED;
    (await import('@/lib/db/pool')).getPool().end();
  });

  it('flag off: every method is 404 and nothing is written', async () => {
    process.env.E2EE_ENABLED = 'off';
    const u = await newUser();
    expect((await call('PUT', tok(u), { blob: blob(), kdf: kdf() })).status).toBe(404);
    expect((await call('GET', tok(u))).status).toBe(404);
    expect((await call('DELETE', tok(u))).status).toBe(404);
    expect((await query('SELECT 1 FROM mx_key_backups WHERE user_id = $1', [u])).rows).toHaveLength(0);
  });

  describe('flag on', () => {
    it('round-trips byte-exact, replaces on a second PUT, and deletes (idempotently)', async () => {
      process.env.E2EE_ENABLED = 'on';
      const u = await newUser();
      expect((await call('GET', tok(u))).status).toBe(404);
      const b1 = blob(300);
      const k1 = kdf();
      expect((await call('PUT', tok(u), { blob: b1, kdf: k1 })).status).toBe(200);
      const got = await call('GET', tok(u));
      expect(got.status).toBe(200);
      expect(got.json.data.blob).toBe(b1);
      expect(got.json.data.kdf).toEqual(k1);
      expect(got.json.data.updatedAt).toBeTruthy();

      const b2 = blob(64);
      expect((await call('PUT', tok(u), { blob: b2, kdf: kdf({ t: 3 }) })).status).toBe(200);
      expect((await call('GET', tok(u))).json.data.blob).toBe(b2);
      expect((await query('SELECT count(*)::int AS n FROM mx_key_backups WHERE user_id = $1', [u])).rows[0].n).toBe(1);

      expect((await call('DELETE', tok(u))).json.data).toEqual({ deleted: true });
      expect((await call('GET', tok(u))).status).toBe(404);
      expect((await call('DELETE', tok(u))).status).toBe(200);
    });

    it('isolation: another user, another project, and tokens without a userId see nothing', async () => {
      process.env.E2EE_ENABLED = 'on';
      const [a, b] = [await newUser(), await newUser()];
      await call('PUT', tok(a), { blob: blob(), kdf: kdf() });
      expect((await call('GET', tok(b))).status).toBe(404);
      expect((await call('GET', tok(a, '00000000-0000-4000-8000-0000000000ff'))).status).not.toBe(200);
      expect((await call('GET', tok())).status).toBe(403); // api token: no userId
      expect((await call('PUT', tok(), { blob: blob(), kdf: kdf() })).status).toBe(403);
      await call('DELETE', tok(b)); // b deleting must not touch a's
      expect((await call('GET', tok(a))).status).toBe(200);
    });

    it('validation: size, base64url, unknown kdf fields, bad parameters', async () => {
      process.env.E2EE_ENABLED = 'on';
      const u = await newUser();
      const put = (b: unknown) => call('PUT', tok(u), b);
      expect((await put({ blob: blob(8192), kdf: kdf() })).status).toBe(200); // exactly at the limit
      expect((await put({ blob: blob(8193), kdf: kdf() })).status).toBe(400);
      expect((await put({ blob: 'not base64url!!', kdf: kdf() })).status).toBe(400);
      expect((await put({ blob: '', kdf: kdf() })).status).toBe(400);
      expect((await put({ blob: blob(), kdf: kdf({ extra: 1 }) })).status).toBe(400);
      expect((await put({ blob: blob(), kdf: kdf({ alg: 'pbkdf2' }) })).status).toBe(400);
      expect((await put({ blob: blob(), kdf: kdf({ v: 2 }) })).status).toBe(400);
      expect((await put({ blob: blob(), kdf: kdf({ m: 1 }) })).status).toBe(400);
      expect((await put({ blob: blob(), kdf: kdf({ salt: randomBytes(4).toString('base64url') }) })).status).toBe(400);
      expect((await put({ blob: blob(), kdf: kdf(), other: true })).status).toBe(400);
      expect((await put({ blob: blob() })).status).toBe(400);
    });

    it('never logs the blob or the kdf', async () => {
      process.env.E2EE_ENABLED = 'on';
      const u = await newUser();
      logSpy.info.mockClear();
      const secret = blob(120);
      await call('PUT', tok(u), { blob: secret, kdf: kdf() });
      await call('GET', tok(u));
      expect(JSON.stringify([...logSpy.info.mock.calls, ...logSpy.warn.mock.calls, ...logSpy.error.mock.calls])).not.toContain(secret);
    });
  });
});
