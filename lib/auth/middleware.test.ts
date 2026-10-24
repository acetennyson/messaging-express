import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'middleware-test-secret';
  process.env.DATABASE_URL ||= 'postgres://postgres:pw@localhost:5432/placeholder';
});

vi.mock('./project', () => ({ loadActiveProject: vi.fn() }));
vi.mock('../logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { requireAuth } from './middleware';
import { loadActiveProject } from './project';
import { AuthError } from '../errors';

const PROJECT = '00000000-0000-4000-8000-0000000000a2';
const token = jwt.sign({ projectId: PROJECT, type: 'api' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
const req = (t: string | null = token) =>
  new NextRequest('http://localhost/api/v1/x', { headers: t ? { authorization: `Bearer ${t}` } : {} });
const json = async (r: Response) => (await r.json()) as { error?: { message: string; code: string } };

const load = vi.mocked(loadActiveProject);
beforeEach(() => {
  load.mockReset();
  load.mockResolvedValue({ organization_id: 'org', organization_name: 'Org' } as never);
});

describe('requireAuth status codes (Track H2)', () => {
  it('passes the handler response through when authenticated', async () => {
    const res = await requireAuth(async () => new Response('ok', { status: 201 }))(req());
    expect(res.status).toBe(201);
  });

  it('401 with the unchanged body for a missing token', async () => {
    const res = await requireAuth(async () => new Response('x'))(req(null));
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: { message: 'Missing authentication token', code: 'UNAUTHORIZED' } });
  });

  it('401 with the unchanged body for an invalid token', async () => {
    const res = await requireAuth(async () => new Response('x'))(req('not.a.token'));
    expect(res.status).toBe(401);
    expect((await json(res)).error?.message).toBe('Invalid or expired token');
  });

  it('401 for an inactive project', async () => {
    load.mockRejectedValue(new AuthError('Project not found or inactive'));
    const res = await requireAuth(async () => new Response('x'))(req());
    expect(res.status).toBe(401);
    expect((await json(res)).error?.message).toBe('Project not found or inactive');
  });

  it('500, not 401, when the database fails while authenticating', async () => {
    load.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const handler = vi.fn(async () => new Response('x'));
    const res = await requireAuth(handler)(req());
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('500, not 401, when the handler throws, and the message is not leaked', async () => {
    const res = await requireAuth(async () => {
      throw new Error('relation "mx_secret" does not exist');
    })(req());
    expect(res.status).toBe(500);
    const b = await json(res);
    expect(b.error?.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(b)).not.toContain('mx_secret');
  });

  it('a handler that throws a typed error keeps its own status', async () => {
    const { NotFoundError } = await import('../errors');
    const res = await requireAuth(async () => {
      throw new NotFoundError('gone');
    })(req());
    expect(res.status).toBe(404);
  });
});
