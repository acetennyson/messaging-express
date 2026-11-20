/** M8: the `rateLimit` init option end to end (options, memory vs postgres store, modes). Needs a test database. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { MessagingServer } from '../server';
import { ConfigError } from '../errors';
import { resolveOptions } from '../options';

const URL_ = process.env.TEST_SCHEMA_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'm8-rate-limit-secret-m8-rate-limit-secret';
const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('rateLimit option validation', () => {
  const base = { database: 'postgres://x@localhost/x', jwtSecret: SECRET };
  it('defaults to off + postgres', () => {
    expect(resolveOptions(base as never).rateLimit).toEqual({ mode: 'off', store: 'postgres' });
  });
  it.each([
    [{ mode: 'on' }, /rateLimit\.mode/],
    [{ store: 'redis' }, /rateLimit\.store/],
    [{ bogus: 1 }, /unknown field 'bogus'/],
    [{ limits: { nope: { limit: 1, windowMs: 1000 } } }, /unknown rule 'nope'/],
    [{ limits: { users: { limit: 0, windowMs: 1000 } } }, /rule 'users'/],
    [{ limits: { users: { limit: 1.5, windowMs: 1000 } } }, /rule 'users'/],
  ])('rejects %j', (rl, msg) => {
    expect(() => resolveOptions({ ...base, rateLimit: rl } as never)).toThrow(ConfigError);
    expect(() => resolveOptions({ ...base, rateLimit: rl } as never)).toThrow(msg);
  });
});

describe.skipIf(!URL_)('rateLimit option (integration)', () => {
  const schema = `m8_${randomBytes(4).toString('hex')}`;
  const admin = new Pool({ connectionString: URL_, max: 2 });
  const open: MessagingServer[] = [];
  const init = async (rateLimit: object, projectName = 'rl') => {
    const s = await MessagingServer.init({ database: URL_!, jwtSecret: SECRET, schema, logger: silent, projectName, rateLimit } as never);
    open.push(s);
    return s;
  };
  const api = jwt.sign({ type: 'api' }, SECRET, { expiresIn: '1h' });
  const hit = async (s: MessagingServer) =>
    s.handler(new Request('http://chat.test/api/v1/users', { headers: { authorization: `Bearer ${api}` } }));
  const tiny = { users: { limit: 2, windowMs: 60_000 } };

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await MessagingServer.migrate({ database: URL_!, schema });
  }, 120_000);
  afterAll(async () => {
    await Promise.all(open.map((s) => s.close({ timeoutMs: 1000 }).catch(() => undefined)));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('off (default) never limits and writes nothing', async () => {
    const s = await init({ limits: tiny }, 'off');
    for (let i = 0; i < 5; i++) expect((await hit(s)).status).toBe(200);
    expect((await admin.query(`SELECT count(*)::int n FROM ${schema}.mx_rate_limits`)).rows[0].n).toBe(0);
  });

  it('enforce + memory: 429 with retry-after on the 3rd request; nothing stored in Postgres', async () => {
    const s = await init({ mode: 'enforce', store: 'memory', limits: tiny }, 'mem-a');
    expect((await hit(s)).status).toBe(200);
    expect((await hit(s)).status).toBe(200);
    const blocked = await hit(s);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await admin.query(`SELECT count(*)::int n FROM ${schema}.mx_rate_limits`)).rows[0].n).toBe(0);
  });

  it('memory is per instance: a second instance has its own counters', async () => {
    const a = await init({ mode: 'enforce', store: 'memory', limits: tiny }, 'mem-b');
    const b = await init({ mode: 'enforce', store: 'memory', limits: tiny }, 'mem-b');
    await hit(a); await hit(a);
    expect((await hit(a)).status).toBe(429);
    expect((await hit(b)).status).toBe(200);
  });

  it('postgres is shared: two instances on one project count together (inside a non-default schema)', async () => {
    const a = await init({ mode: 'enforce', store: 'postgres', limits: tiny }, 'pg-shared');
    const b = await init({ mode: 'enforce', store: 'postgres', limits: tiny }, 'pg-shared');
    expect((await hit(a)).status).toBe(200);
    expect((await hit(b)).status).toBe(200);
    expect((await hit(a)).status).toBe(429);
    expect((await hit(b)).status).toBe(429);
  });

  it('dry-run never blocks', async () => {
    const s = await init({ mode: 'dry-run', store: 'memory', limits: tiny }, 'dry');
    for (let i = 0; i < 5; i++) expect((await hit(s)).status).toBe(200);
  });
});
