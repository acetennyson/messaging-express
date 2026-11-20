import { describe, expect, it } from 'vitest';
import { matchPattern, matchRoute, route, type RouteDef } from './routing';
import { routes } from './routes';

const noop = async () => new Response('x');

describe('matchPattern', () => {
  it('matches literals and named params, decoding params once like Next', () => {
    expect(matchPattern('/api/v1/devices/:id', '/api/v1/devices/abc')).toEqual({ id: 'abc' });
    expect(matchPattern('/a/:x/b', '/a/hello%20world/b')).toEqual({ x: 'hello world' });
    expect(matchPattern('/a/:x', '/a/%2541')).toEqual({ x: '%41' }); // decoded exactly once
  });

  it('ignores a trailing slash, and requires every segment', () => {
    expect(matchPattern('/api/v1/users', '/api/v1/users/')).toEqual({});
    expect(matchPattern('/api/v1/users', '/api/v1')).toBeNull();
    expect(matchPattern('/api/v1/users', '/api/v1/users/extra')).toBeNull();
    expect(matchPattern('/a/:x/b', '/a/b')).toBeNull();
  });

  it('a "*rest" segment takes one or more remaining segments, each decoded', () => {
    expect(matchPattern('/uploads/*path', '/uploads/a/b%20c.png')).toEqual({ path: ['a', 'b c.png'] });
    expect(matchPattern('/uploads/*path', '/uploads')).toBeNull();
    expect(() => matchPattern('/x/*rest/y', '/x/1/y')).toThrow(/last segment/);
  });

  it('malformed percent-encoding never matches (no 500 from the matcher)', () => {
    expect(matchPattern('/a/:x', '/a/%E0%A4%A')).toBeNull();
    expect(matchPattern('/uploads/*path', '/uploads/%')).toBeNull();
  });
});

describe('matchRoute', () => {
  const table: RouteDef[] = [
    route('DELETE', '/devices/:id', noop),
    route('GET', '/devices/backup', noop),
    route('GET', '/devices/:id', noop),
    route('GET', '/files/*rest', noop),
  ];

  it('prefers the most specific pattern whatever the table order', () => {
    expect(matchRoute(table, 'GET', '/devices/backup')?.route.pattern).toBe('/devices/backup');
    expect(matchRoute(table, 'GET', '/devices/123')?.route.pattern).toBe('/devices/:id');
    expect(matchRoute([...table].reverse(), 'GET', '/devices/backup')?.route.pattern).toBe('/devices/backup');
  });

  it('matches on method too, and returns null otherwise', () => {
    expect(matchRoute(table, 'DELETE', '/devices/backup')?.route.pattern).toBe('/devices/:id');
    expect(matchRoute(table, 'POST', '/devices/1')).toBeNull();
    expect(matchRoute(table, 'GET', '/nope')).toBeNull();
  });
});

describe('the real route table', () => {
  it('has no duplicate method+pattern', () => {
    const keys = routes.map((r) => `${r.method} ${r.pattern}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('every public API path has an OPTIONS preflight except health and the cron endpoint', () => {
    const paths = new Set(routes.map((r) => r.pattern));
    for (const p of paths) {
      const preflight = routes.some((r) => r.method === 'OPTIONS' && r.pattern === p);
      const exempt = p === '/api/health' || p.startsWith('/api/internal/');
      expect(preflight, `${p} preflight`).toBe(!exempt);
    }
  });

  it('every pattern resolves to itself through matchRoute (no route is shadowed)', () => {
    for (const r of routes) {
      const sample = r.pattern.replace(/:\w+/g, 'x1').replace(/\*\w+/, 'f/g.png');
      expect(matchRoute(routes, r.method, sample)?.route, `${r.method} ${r.pattern}`).toBe(r);
    }
  });
});
