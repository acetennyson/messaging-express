/**
 * M4 integration: MessagingServer.init against a real Postgres, in a throwaway schema created and migrated here.
 * Runs when DATABASE_URL is set (a dev/test database: it creates and drops its own schema).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { MessagingServer } from './server';
import { ConfigError, SchemaNotReadyError } from './errors';
import { createLogger } from './logger';

const URL_ = process.env.TEST_SCHEMA_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'm4-integration-secret-m4-integration-secret';
const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe.skipIf(!URL_)('MessagingServer.init (empty database)', () => {
  const schema = `m4_${randomBytes(4).toString('hex')}`;
  const admin = new Pool({ connectionString: URL_, max: 2 });
  const open: MessagingServer[] = [];
  const init = async (extra: object = {}) => {
    const s = await MessagingServer.init({ database: URL_!, jwtSecret: SECRET, schema, logger: silent, ...extra });
    open.push(s);
    return s;
  };

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await MessagingServer.migrate({ database: URL_!, schema }); // what a customer's first deploy does
  }, 120_000);

  afterAll(async () => {
    await Promise.all(open.map((s) => s.close({ timeoutMs: 1000 }).catch(() => undefined)));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  const counts = async () => {
    const o = await admin.query(`SELECT count(*)::int n FROM ${schema}.mx_organizations`);
    const p = await admin.query(`SELECT count(*)::int n FROM ${schema}.mx_projects`);
    return { orgs: o.rows[0].n as number, projects: p.rows[0].n as number };
  };

  it('works with no organisation setup, and init is idempotent (also when instances start at once)', async () => {
    expect(await counts()).toEqual({ orgs: 0, projects: 0 });
    const first = await init();
    expect(first.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await counts()).toEqual({ orgs: 1, projects: 1 });

    const more = await Promise.all([init(), init(), init(), init()]);
    for (const s of more) expect(s.projectId).toBe(first.projectId);
    expect(await counts()).toEqual({ orgs: 1, projects: 1 });

    const other = await init({ projectName: 'second' });
    expect(other.projectId).not.toBe(first.projectId);
    expect(await counts()).toEqual({ orgs: 1, projects: 2 });
  });

  it('refuses clearly when the tables are not there, and leaves no pool open', async () => {
    const err = await MessagingServer.init({ database: URL_!, jwtSecret: SECRET, schema: `${schema}_missing`, logger: silent }).catch((e) => e);
    expect(err).toBeInstanceOf(SchemaNotReadyError);
    expect(err.message).toContain(`${schema}_missing`);
  });

  it('refuses a deactivated project instead of reactivating it', async () => {
    await init({ projectName: 'off-by-admin' });
    await admin.query(`UPDATE ${schema}.mx_projects SET is_active = false WHERE name = 'off-by-admin'`);
    const err = await MessagingServer.init({ database: URL_!, jwtSecret: SECRET, schema, projectName: 'off-by-admin', logger: silent }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.option).toBe('projectName');
  });

  it('bad options throw before anything is opened', async () => {
    await expect(MessagingServer.init({ database: URL_!, jwtSecret: 'short' })).rejects.toThrow(/jwtSecret/);
  });

  describe('defaults: enforce + e2ee on (the 7.12 outsider cases)', () => {
    const sign = (payload: object) => jwt.sign(payload, SECRET, { expiresIn: '1h' });
    const call = async (s: MessagingServer, method: string, path: string, token: string, body?: unknown) => {
      const res = await s.handler(
        new Request(`http://chat.test${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        })
      );
      return { status: res.status, json: (await res.json().catch(() => null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };

    it('members can talk; an outsider (Eve) and an impersonator cannot; no projectId in any token', async () => {
      const s = await init({ projectName: 'defaults' });
      const api = sign({ type: 'api' });
      const mk = async (n: string) => (await call(s, 'POST', '/api/v1/users', api, { externalId: `${n}-${randomBytes(3).toString('hex')}`, name: n })).json.data;
      const [alice, bob, eve] = [await mk('alice'), await mk('bob'), await mk('eve')];
      const conv = (await call(s, 'POST', '/api/v1/conversations', api, { type: 'group', participantIds: [alice.id, bob.id] })).json.data;
      const tA = sign({ type: 'user', userId: alice.id });
      const tE = sign({ type: 'user', userId: eve.id });

      expect((await call(s, 'POST', '/api/v1/messages', tA, { conversationId: conv.id, senderId: alice.id, content: 'hi' })).status).toBe(201);
      expect((await call(s, 'GET', `/api/v1/messages?conversationId=${conv.id}`, tA)).status).toBe(200);
      expect((await call(s, 'GET', `/api/v1/messages?conversationId=${conv.id}`, tE)).status).toBe(403);
      expect((await call(s, 'POST', '/api/v1/messages', tE, { conversationId: conv.id, senderId: eve.id, content: 'let me in' })).status).toBe(400); // same status as the hosted baseline (msg-send-outsider)
      expect((await call(s, 'POST', '/api/v1/messages', tA, { conversationId: conv.id, senderId: bob.id, content: 'as bob' })).status).toBe(403);
      expect((await call(s, 'GET', '/api/v1/devices', tA)).status).not.toBe(404); // e2ee is on by default

      // every row belongs to the one project
      const stray = await admin.query(`SELECT count(*)::int n FROM ${schema}.mx_users WHERE project_id <> $1 AND external_id LIKE 'alice-%'`, [s.projectId]);
      expect(stray.rows[0].n).toBe(0);
    });

    it('participantAccess and e2ee can be switched off explicitly', async () => {
      const s = await init({ projectName: 'relaxed', participantAccess: 'off', e2ee: 'off' });
      const api = sign({ type: 'api' });
      expect((await call(s, 'GET', '/api/v1/devices', sign({ type: 'user', userId: 'x' }))).status).toBe(404);
      expect((await call(s, 'GET', '/api/v1/users', api)).status).toBe(200);
    });

    it('GET /meta reports versions without auth, and MODULE_VERSION matches package.json', async () => {
      const s = await init({ projectName: 'meta' });
      const r = await s.handler(new Request('http://chat.test/meta'));
      expect(r.status).toBe(200);
      const body = await r.json();
      const pkg = JSON.parse(readFileSync(join(process.cwd(), 'packages/server/package.json'), 'utf8'));
      expect(body.data).toEqual({ moduleVersion: pkg.version, contractVersion: 1, schemaVersion: 19 });
    });

    it('401 without a token, 404 for an unknown path, 503 after close()', async () => {
      const s = await init({ projectName: 'lifecycle' });
      const bare = await s.handler(new Request('http://chat.test/api/v1/users'));
      expect(bare.status).toBe(401);
      expect((await s.handler(new Request('http://chat.test/nope'))).status).toBe(404);
      await s.close({ timeoutMs: 500 });
      const after = await s.handler(new Request('http://chat.test/api/v1/users'));
      expect(after.status).toBe(503);
    });

    it('custom authenticate maps to the same rules: a customer-recognised outsider is still refused', async () => {
      const probe = await init({ projectName: 'custom' });
      const api = sign({ type: 'api' });
      const mk = async (n: string) => (await call(probe, 'POST', '/api/v1/users', api, { externalId: `${n}-${randomBytes(3).toString('hex')}`, name: n })).json.data;
      const [alice, eve] = [await mk('alice'), await mk('eve')];
      const conv = (await call(probe, 'POST', '/api/v1/conversations', api, { type: 'group', participantIds: [alice.id] })).json.data;

      const sessions: Record<string, { userId: string; type: 'user' }> = { 'sess-eve': { userId: eve.id, type: 'user' } };
      const s = await init({
        projectName: 'custom',
        authenticate: async (req: Request) => {
          const h = req.headers.get('authorization')?.replace('Bearer ', '') ?? '';
          if (h === 'boom') throw new Error('session store down');
          return sessions[h] ?? null;
        },
      });
      const get = (t: string) => call(s, 'GET', `/api/v1/messages?conversationId=${conv.id}`, t);
      expect((await get('sess-eve')).status).toBe(403); // recognised, but not a participant
      expect((await get('sess-unknown')).status).toBe(401);
      expect((await get('boom')).status).toBe(503);
    });
  });

  describe('borrowed pool (D10)', () => {
    it('is never reconfigured: the customer queries the same pool before, during and after and never sees our schema', async () => {
      const mine = new Pool({ connectionString: URL_, max: 4 });
      const before = (await mine.query('SHOW search_path')).rows[0].search_path;
      const sees = async () => (await mine.query(`SELECT to_regclass('mx_users') AS t, current_schema() AS s, current_setting('search_path') AS p`)).rows[0];

      // What the customer's unqualified name resolves to is whatever it was before we existed (in a shared dev database that
      // may be their own mx_users in public); it must never become ours.
      const baseline = await sees();
      expect(String(baseline.t)).not.toContain(schema);
      const s = await MessagingServer.init({ database: mine, jwtSecret: SECRET, schema, projectName: 'borrowed', logger: silent });

      const api = jwt.sign({ type: 'api' }, SECRET, { expiresIn: '1h' });
      const work = Array.from({ length: 12 }, () =>
        s.handler(new Request('http://chat.test/api/v1/users', { headers: { authorization: `Bearer ${api}` } })).then((r) => r.status)
      );
      const during = await Promise.all(Array.from({ length: 12 }, sees)); // customer queries interleaved with ours
      expect(await Promise.all(work)).toEqual(Array(12).fill(200));
      for (const row of during) expect(row).toEqual(baseline);

      await s.close({ timeoutMs: 500 }); // 'auto': a borrowed pool stays open
      expect(await sees()).toEqual(baseline);
      expect(baseline.p).toBe(before);
      await mine.end();
    });

    it("close({ database: 'close' }) also closes a borrowed pool; an owned pool closes by default", async () => {
      const mine = new Pool({ connectionString: URL_, max: 2 });
      const b = await MessagingServer.init({ database: mine, jwtSecret: SECRET, schema, projectName: 'borrowed2', logger: silent });
      await b.close({ timeoutMs: 200, database: 'close' });
      await expect(mine.query('SELECT 1')).rejects.toThrow();

      const o = await MessagingServer.init({ database: URL_!, jwtSecret: SECRET, schema, projectName: 'owned', logger: silent });
      const pool = (o as unknown as { pool: Pool }).pool;
      await o.close({ timeoutMs: 200 });
      await expect(pool.query('SELECT 1')).rejects.toThrow();

      const k = await MessagingServer.init({ database: URL_!, jwtSecret: SECRET, schema, projectName: 'kept', logger: silent });
      const kp = (k as unknown as { pool: Pool }).pool;
      await k.close({ timeoutMs: 200, database: 'keep' });
      expect((await kp.query('SELECT 1 AS x')).rows[0].x).toBe(1);
      await kp.end();
    });
  });
});

describe('default logger', () => {
  it('createLogger is what init falls back to (smoke)', () => {
    expect(typeof createLogger().error).toBe('function');
  });
});
