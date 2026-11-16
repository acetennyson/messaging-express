/**
 * M1 proof tests. They build a ServerContext from the core pieces only (no lib/hosted), so they show what an embedder
 * gets: (1) the core runs with an EMPTY process.env, (2) two instances in one process share nothing.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { createConfig } from './config';
import { createDb } from './db';
import { createInflightTracker, detachedDefer } from './inflight';
import { listUsers } from './users';
import type { Logger } from '../logger';
import { createRealtimeRegistry } from '../realtime';
import { createEnvStorage } from '../storage';
import { createPostgresRateLimiter } from '../rate-limit/providers/postgres';
import { signToken, verifyToken } from '../auth/jwt';
import { emitEvent } from '../events/emit';
import type { ServerContext } from './context';

const DATABASE_URL = process.env.DATABASE_URL; // read ONCE, before any trap is installed
const SCHEMA_DATABASE_URL = process.env.TEST_SCHEMA_DATABASE_URL; // optional: a database holding the tables in schema "messaging"
const PROJECT = '00000000-0000-4000-8000-0000000000a2'; // scripts/smoke-seed.sql

interface Built {
  ctx: ServerContext;
  logs: Array<{ level: string; event: string }>;
  pool?: Pool;
}

/** What an embedder would write: every input is passed in; nothing is read from the environment. */
function build(opts: { env: Record<string, string>; connectionString?: string; schema?: string }): Built {
  const logs: Built['logs'] = [];
  const record = (level: string) => (event: string) => void logs.push({ level, event });
  const logger: Logger = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
  const read = (name: string) => opts.env[name];
  const pool = opts.connectionString ? new Pool({ connectionString: opts.connectionString, max: 2 }) : undefined;
  const db = pool
    ? createDb({ pool, schema: opts.schema })
    : ({ query: async () => ({ rows: [] }), transaction: async () => undefined, t: (n: string) => `mx_${n}` } as never);
  const inflight = createInflightTracker();
  const ctx: ServerContext = {
    config: createConfig(read, { warn: (event) => logger.warn(event) }),
    logger,
    db,
    storage: createEnvStorage(read),
    realtime: createRealtimeRegistry({ onError: (event) => logger.error(event) }),
    projectCache: new Map(),
    rateLimiter: createPostgresRateLimiter({ db, logger }),
    inflight,
    defer: detachedDefer(inflight),
  };
  return { ctx, logs, pool };
}

const SECRET_A = 'instance-a-secret-instance-a-secret-aa';
const SECRET_B = 'instance-b-secret-instance-b-secret-bb';
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('the core with an empty process.env', () => {
  it('builds and runs without reading any environment variable of its own', async () => {
    const touched = new Set<string>();
    const realEnv = process.env;
    const spy = new Proxy({} as NodeJS.ProcessEnv, {
      get: (_t, key) => {
        if (typeof key === 'string') touched.add(key);
        return undefined;
      },
      has: (_t, key) => {
        if (typeof key === 'string') touched.add(key);
        return false;
      },
      ownKeys: () => [],
    });

    // The pool is created before the trap: pg resolves PG* defaults at construction. The embedder passes a connection string.
    const built = build({ env: { JWT_SECRET: SECRET_A }, connectionString: DATABASE_URL });
    Object.defineProperty(process, 'env', { value: spy, configurable: true, writable: true });
    try {
      const { ctx } = built;
      const token = signToken(ctx, { userId: 'u1', projectId: PROJECT, organizationId: 'o1' } as never);
      expect(verifyToken(ctx, token)).toMatchObject({ userId: 'u1' });

      // config accessors fall back to defaults, they do not look elsewhere
      expect(ctx.config.rateLimitMode()).toBeDefined();
      expect(ctx.config.maxDevicesPerUser()).toBe(10);
      expect(ctx.config.webhookDispatch()).toBe('off');

      // deferred work + realtime publish (no provider registered: a silent no-op, never an error)
      emitEvent(ctx, { projectId: PROJECT, event: 'message.created', data: {}, channel: 'conversation:c1' });
      const ran = vi.fn(async () => undefined);
      ctx.defer(ran);
      expect(await ctx.inflight.drain(500)).toBe(0);
      expect(ran).toHaveBeenCalledTimes(1);

      if (DATABASE_URL) {
        const r = await listUsers(ctx, PROJECT, { limit: 10, offset: 0 });
        expect(r.total).toBeGreaterThanOrEqual(0);
        const verdict = await ctx.rateLimiter.check(`empty-env-${Date.now()}`, 5, 60_000);
        expect(verdict.allowed).toBe(true);
      }
    } finally {
      Object.defineProperty(process, 'env', { value: realEnv, configurable: true, writable: true });
      await built.pool?.end();
    }
    // The core itself read nothing. The only reads are the pg driver resolving its own PG* defaults when it connects
    // (the embedder's pool, not our code); an embedder who sets those on the pool never needs the environment either.
    expect([...touched].filter((k) => !k.startsWith('PG'))).toEqual([]);
  });

  it('fails fast and clearly when the one required value is missing', () => {
    expect(() => build({ env: {} })).toThrow('JWT_SECRET environment variable is not set');
  });
});

describe('two instances in one process', () => {
  const a = build({ env: { JWT_SECRET: SECRET_A, MAX_DEVICES_PER_USER: '3' } });
  const b = build({ env: { JWT_SECRET: SECRET_B } });

  it('have independent config', () => {
    expect(a.ctx.config.maxDevicesPerUser()).toBe(3);
    expect(b.ctx.config.maxDevicesPerUser()).toBe(10);
  });

  it('do not accept each other’s tokens', () => {
    const t = signToken(a.ctx, { userId: 'u1', projectId: PROJECT, organizationId: 'o1' } as never);
    expect(verifyToken(a.ctx, t)).toMatchObject({ userId: 'u1' });
    expect(() => verifyToken(b.ctx, t)).toThrow();
  });

  it('have their own project cache', () => {
    a.ctx.projectCache.set('k', { project: { id: 'a' }, expiresAt: Date.now() + 1000 });
    expect(a.ctx.projectCache.has('k')).toBe(true);
    expect(b.ctx.projectCache.has('k')).toBe(false);
  });

  it('have their own realtime registry: a publish on A never reaches B', async () => {
    const pubA = vi.fn().mockResolvedValue(undefined);
    const pubB = vi.fn().mockResolvedValue(undefined);
    a.ctx.realtime.register({ publish: pubA } as never);
    b.ctx.realtime.register({ publish: pubB } as never);
    emitEvent(a.ctx, { projectId: PROJECT, event: 'message.created', data: {}, channel: 'conversation:c1' });
    await tick();
    expect(pubA).toHaveBeenCalledTimes(1);
    expect(pubB).not.toHaveBeenCalled();
    a.ctx.realtime.unregister();
    expect(b.ctx.realtime.get()).not.toBeNull();
    b.ctx.realtime.unregister();
  });

  it('track in-flight work separately, so one instance’s shutdown does not wait on the other', async () => {
    let release!: () => void;
    a.ctx.defer(() => new Promise<void>((r) => (release = r)));
    await tick();
    expect(a.ctx.inflight.count()).toBe(1);
    expect(b.ctx.inflight.count()).toBe(0);
    expect(await b.ctx.inflight.drain(20)).toBe(0);
    release();
    expect(await a.ctx.inflight.drain(500)).toBe(0);
  });

  it('log through their own logger', () => {
    a.logs.length = 0;
    b.logs.length = 0;
    a.ctx.logger.warn('only_a');
    expect(a.logs).toHaveLength(1);
    expect(b.logs).toHaveLength(0);
  });

  it('keep separate rate-limit counters (limiter state is per instance)', () => {
    expect(a.ctx.rateLimiter).not.toBe(b.ctx.rateLimiter);
  });
});

describe.skipIf(!DATABASE_URL || !SCHEMA_DATABASE_URL)('two instances, two data layouts (real databases)', () => {
  const a = build({ env: { JWT_SECRET: SECRET_A }, connectionString: DATABASE_URL }); // hosted style: unqualified tables
  const b = build({ env: { JWT_SECRET: SECRET_B }, connectionString: SCHEMA_DATABASE_URL, schema: 'messaging' });
  afterAll(async () => {
    await a.pool?.end();
    await b.pool?.end();
  });

  const marker = `instances-marker-${Date.now()}`;

  it('each reads its own tables: a user that exists only in B\'s schema is visible to B and invisible to A', async () => {
    await b.pool!.query(
      `INSERT INTO "messaging".mx_users (id, project_id, external_id, name, email) VALUES (gen_random_uuid(), $1, $2, 'Marker', 'marker@example.com')`,
      [PROJECT, marker]
    );
    try {
      expect((await listUsers(b.ctx, PROJECT, { limit: 10, offset: 0, externalId: marker })).rows).toHaveLength(1);
      expect((await listUsers(a.ctx, PROJECT, { limit: 10, offset: 0, externalId: marker })).rows).toHaveLength(0);
    } finally {
      await b.pool!.query(`DELETE FROM "messaging".mx_users WHERE external_id = $1`, [marker]);
    }
  });
});
