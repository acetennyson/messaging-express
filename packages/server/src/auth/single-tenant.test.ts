import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createSingleTenantAuth, type CustomAuthenticate } from './single-tenant';
import { requireAuth } from './middleware';
import { AuthError, AuthUnavailableError } from '../errors';
import { testContext } from '../core/testing';

const project = { id: 'proj-1', organization_id: 'org-1', organization_name: 'Embedded' };

function setup(authenticate?: CustomAuthenticate, timeoutMs = 50) {
  const base = testContext();
  const auth = createSingleTenantAuth({ project, authenticate, timeoutMs });
  const ctx = { ...base, auth };
  const sign = (payload: object, opts: jwt.SignOptions = { expiresIn: '1h' }) => jwt.sign(payload, ctx.config.jwt.secret, opts);
  const req = (token?: string) => new Request('http://x/api/v1/y', { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { ctx, auth, sign, req };
}

describe('single-tenant JWT', () => {
  it('maps a token to the fixed project; any projectId in the token is ignored', async () => {
    const { ctx, auth, sign, req } = setup();
    const c = await auth.authenticate(ctx, req(sign({ userId: 'u1', type: 'user', projectId: 'someone-else' })));
    expect(c).toMatchObject({ projectId: 'proj-1', organizationId: 'org-1', userId: 'u1', type: 'user' });
    expect(c.organization).toEqual({ id: 'org-1', name: 'Embedded' });
    expect(c.exp).toBeTypeOf('number');
    expect((await auth.authenticate(ctx, req(sign({ type: 'api' })))).type).toBe('api');
    expect((await auth.authenticate(ctx, req(sign({ type: 'admin' })))).type).toBe('admin');
  });

  it('401 for missing, malformed, expired, wrong-secret and bad-type tokens', async () => {
    const { ctx, auth, sign, req } = setup();
    const bad = [
      req(),
      req('garbage'),
      req(sign({ type: 'user', userId: 'u' }, { expiresIn: -10 })),
      req(jwt.sign({ type: 'user', userId: 'u' }, 'another-secret-another-secret-another')),
      req(sign({ type: 'root' })),
    ];
    for (const r of bad) await expect(auth.authenticate(ctx, r)).rejects.toBeInstanceOf(AuthError);
  });

  it('authenticateToken (realtime handshake) is JWT only', async () => {
    const { ctx, auth, sign } = setup(async () => ({ userId: 'x', type: 'user' }));
    expect((await auth.authenticateToken(ctx, sign({ userId: 'u', type: 'user' }))).userId).toBe('u');
    await expect(auth.authenticateToken(ctx, 'nope')).rejects.toMatchObject({ reason: 'invalid_token' });
  });
});

describe('custom authenticate() contract (D4)', () => {
  it('null is a 401', async () => {
    const { ctx, auth, req } = setup(async () => null);
    await expect(auth.authenticate(ctx, req())).rejects.toBeInstanceOf(AuthError);
  });

  it('returns each type and maps it to the same AuthContext', async () => {
    for (const type of ['user', 'api', 'admin'] as const) {
      const { ctx, auth, req } = setup(async () => ({ userId: 'u9', type }));
      expect(await auth.authenticate(ctx, req())).toMatchObject({ projectId: 'proj-1', userId: 'u9', type });
    }
    const { ctx, auth, req } = setup(() => ({ type: 'api' })); // sync result, no userId: fine for api
    expect((await auth.authenticate(ctx, req())).userId).toBeUndefined();
  });

  it('a throw (sync or async) is a 503, logged, never a 401', async () => {
    for (const fn of [
      async () => {
        throw new Error('db down: password=hunter2');
      },
      () => {
        throw new Error('sync');
      },
    ]) {
      const { ctx, auth, req } = setup(fn as CustomAuthenticate);
      const err = await auth.authenticate(ctx, req()).catch((e) => e);
      expect(err).toBeInstanceOf(AuthUnavailableError);
      expect(err.status).toBe(503);
      expect(err.message).not.toContain('hunter2');
    }
  });

  it('a hung call becomes a 503 after the timeout', async () => {
    const { ctx, auth, req } = setup(() => new Promise(() => {}), 30);
    const t = Date.now();
    await expect(auth.authenticate(ctx, req())).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('nonsense results never grant access', async () => {
    for (const bad of ['yes', 42, {}, { type: 'root' }, { type: 'user' }, { userId: '', type: 'user' }, { userId: 5, type: 'user' }, undefined]) {
      const { ctx, auth, req } = setup(async () => bad as never);
      await expect(auth.authenticate(ctx, req())).rejects.toBeInstanceOf(AuthUnavailableError);
    }
  });

  it('our JWT wins without calling authenticate; a token that is not ours falls through to it', async () => {
    const fn = vi.fn(async () => ({ userId: 'from-custom', type: 'user' as const }));
    const { ctx, auth, sign, req } = setup(fn);
    expect((await auth.authenticate(ctx, req(sign({ userId: 'from-jwt', type: 'user' })))).userId).toBe('from-jwt');
    expect(fn).not.toHaveBeenCalled();
    expect((await auth.authenticate(ctx, req('their-session-token'))).userId).toBe('from-custom');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('through requireAuth: 401 body unchanged, 503 body generic', async () => {
    const handler = requireAuth(async () => new Response('ok'));
    const a = setup(async () => null);
    const r401 = await handler(a.req(), a.ctx);
    expect(r401.status).toBe(401);
    const b = setup(async () => {
      throw new Error('secret detail');
    });
    const r503 = await handler(b.req(), b.ctx);
    expect(r503.status).toBe(503);
    const text = await r503.text();
    expect(text).toContain('authentication_unavailable');
    expect(text).not.toContain('secret detail');
  });
});
