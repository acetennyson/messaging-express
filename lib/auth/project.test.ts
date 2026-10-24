import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgres://postgres:pw@localhost:5432/placeholder';
});
vi.mock('../db/pool', () => ({ query: vi.fn() }));
vi.mock('../logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { query } from '../db/pool';
import { loadActiveProject, clearProjectCache } from './project';
import { AuthError } from '../errors';
import { getProjectCacheTtlSeconds } from '../config/flags';

const q = vi.mocked(query);
const row = (over: object = {}) => ({ rows: [{ id: 'p1', organization_id: 'o1', organization_name: 'Org', org_active: true, ...over }] });

beforeEach(() => {
  q.mockReset();
  clearProjectCache();
  vi.useFakeTimers();
  delete process.env.PROJECT_CACHE_TTL_SECONDS;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.PROJECT_CACHE_TTL_SECONDS;
});

describe('PROJECT_CACHE_TTL_SECONDS parsing', () => {
  it.each([
    [undefined, 0], ['', 0], ['0', 0], ['abc', 0], ['-5', 0], ['0.5', 0],
    ['15', 15], [' 30 ', 30], ['15.9', 15], ['99999', 3600],
  ])('%j -> %i', (raw, expected) => {
    if (raw === undefined) delete process.env.PROJECT_CACHE_TTL_SECONDS;
    else process.env.PROJECT_CACHE_TTL_SECONDS = raw;
    expect(getProjectCacheTtlSeconds()).toBe(expected);
  });
});

describe('loadActiveProject (Track H4)', () => {
  it('queries every time when the cache is off (default)', async () => {
    q.mockResolvedValue(row() as never);
    await loadActiveProject('p1');
    await loadActiveProject('p1');
    expect(q).toHaveBeenCalledTimes(2);
  });

  it('reuses a successful lookup until the TTL passes, then queries again', async () => {
    process.env.PROJECT_CACHE_TTL_SECONDS = '15';
    q.mockResolvedValue(row() as never);
    await loadActiveProject('p1');
    await loadActiveProject('p1');
    vi.advanceTimersByTime(14_000);
    await loadActiveProject('p1');
    expect(q).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await loadActiveProject('p1');
    expect(q).toHaveBeenCalledTimes(2);
  });

  it('caches per project', async () => {
    process.env.PROJECT_CACHE_TTL_SECONDS = '15';
    q.mockResolvedValue(row() as never);
    await loadActiveProject('p1');
    await loadActiveProject('p2');
    expect(q).toHaveBeenCalledTimes(2);
  });

  it('never caches a failure: a project that becomes active works at once', async () => {
    process.env.PROJECT_CACHE_TTL_SECONDS = '15';
    q.mockResolvedValueOnce({ rows: [] } as never);
    await expect(loadActiveProject('p1')).rejects.toBeInstanceOf(AuthError);
    q.mockResolvedValueOnce(row() as never);
    await expect(loadActiveProject('p1')).resolves.toMatchObject({ id: 'p1' });
    expect(q).toHaveBeenCalledTimes(2);
  });

  it('does not cache an inactive organization', async () => {
    process.env.PROJECT_CACHE_TTL_SECONDS = '15';
    q.mockResolvedValueOnce(row({ org_active: false }) as never);
    await expect(loadActiveProject('p1')).rejects.toThrow('Organization inactive');
    q.mockResolvedValueOnce(row() as never);
    await expect(loadActiveProject('p1')).resolves.toBeTruthy();
  });

  it('a deactivated project keeps working until the TTL, then fails (the documented trade-off)', async () => {
    process.env.PROJECT_CACHE_TTL_SECONDS = '15';
    q.mockResolvedValueOnce(row() as never);
    await loadActiveProject('p1');
    q.mockResolvedValue({ rows: [] } as never); // deactivated in the database now
    await expect(loadActiveProject('p1')).resolves.toBeTruthy();
    vi.advanceTimersByTime(16_000);
    await expect(loadActiveProject('p1')).rejects.toBeInstanceOf(AuthError);
  });

  it('turning the TTL off at runtime stops serving cached entries', async () => {
    process.env.PROJECT_CACHE_TTL_SECONDS = '60';
    q.mockResolvedValue(row() as never);
    await loadActiveProject('p1');
    delete process.env.PROJECT_CACHE_TTL_SECONDS;
    await loadActiveProject('p1');
    expect(q).toHaveBeenCalledTimes(2);
  });

  it('returns copies, so a caller cannot change what the next request sees', async () => {
    process.env.PROJECT_CACHE_TTL_SECONDS = '15';
    q.mockResolvedValue(row() as never);
    const a = await loadActiveProject('p1');
    a.organization_name = 'tampered';
    const b = await loadActiveProject('p1');
    expect(b.organization_name).toBe('Org');
  });

  it('is bounded: the oldest entry is evicted past 1000 projects', async () => {
    process.env.PROJECT_CACHE_TTL_SECONDS = '60';
    q.mockResolvedValue(row() as never);
    for (let i = 0; i < 1001; i++) await loadActiveProject(`p${i}`);
    q.mockClear();
    await loadActiveProject('p1000'); // newest: still cached
    expect(q).not.toHaveBeenCalled();
    await loadActiveProject('p0'); // oldest: evicted
    expect(q).toHaveBeenCalledTimes(1);
  });
});
