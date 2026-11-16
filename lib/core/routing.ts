import type { ServerContext } from './context';

/**
 * The one list of routes. Both the hosted Next.js server and (from M6) the Node/Express adapter dispatch through it, so
 * there is exactly one definition of "which handler serves which method and path".
 */
export type RouteParams = Record<string, string | string[]>;

/** Handlers take `(request, ctx, params)`; the wrappers (withCors, requireAuth, e2eeOnly) are already composed in. */
export type RouteHandler = (req: Request, ctx: ServerContext, params: RouteParams) => Promise<Response> | Response;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface RouteDef {
  method: HttpMethod;
  /** `/api/v1/conversations/:id/keys`; `:name` is one path segment, `*name` is the rest of the path (last segment only). */
  pattern: string;
  handler: RouteHandler;
}

export function route(method: HttpMethod, pattern: string, handler: RouteHandler): RouteDef {
  return { method, pattern, handler };
}

interface Compiled {
  segments: Array<{ kind: 'lit'; value: string } | { kind: 'param'; name: string } | { kind: 'rest'; name: string }>;
}

const compiled = new Map<string, Compiled>();

function compile(pattern: string): Compiled {
  let c = compiled.get(pattern);
  if (!c) {
    const parts = pattern.split('/').filter(Boolean);
    c = {
      segments: parts.map((p, i) => {
        if (p.startsWith(':')) return { kind: 'param' as const, name: p.slice(1) };
        if (p.startsWith('*')) {
          if (i !== parts.length - 1) throw new Error(`Route pattern ${pattern}: "*" is only allowed on the last segment`);
          return { kind: 'rest' as const, name: p.slice(1) };
        }
        return { kind: 'lit' as const, value: p };
      }),
    };
    compiled.set(pattern, c);
  }
  return c;
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null; // malformed percent-encoding never matches a route
  }
}

/**
 * Match a pathname against a pattern. Params are decoded once, exactly as Next.js decodes its dynamic params, so a
 * handler sees the same values whichever server runs it. A trailing slash is ignored. Returns null on no match.
 */
export function matchPattern(pattern: string, pathname: string): RouteParams | null {
  const { segments } = compile(pattern);
  const actual = pathname.split('/').filter(Boolean);
  const params: RouteParams = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === 'rest') {
      const rest = actual.slice(i);
      if (rest.length === 0) return null;
      const decoded = rest.map(decode);
      if (decoded.some((d) => d === null)) return null;
      params[seg.name] = decoded as string[];
      return params;
    }
    const value = actual[i];
    if (value === undefined) return null;
    if (seg.kind === 'lit') {
      if (value !== seg.value) return null;
    } else {
      const d = decode(value);
      if (d === null) return null;
      params[seg.name] = d;
    }
  }
  return actual.length === segments.length ? params : null;
}

/** How specific a pattern is: literal segments beat `:param`, which beats `*rest`. Mirrors Next's own precedence. */
function specificity(pattern: string): number[] {
  return compile(pattern).segments.map((s) => (s.kind === 'lit' ? 2 : s.kind === 'param' ? 1 : 0));
}

function moreSpecific(a: string, b: string): boolean {
  const x = specificity(a);
  const y = specificity(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) > (y[i] ?? -1);
  }
  return false;
}

/**
 * Find the route for a request, or null. Used by every adapter. When several patterns match (`/devices/:id` and
 * `/devices/pair` both match `/devices/pair`) the most specific wins, so the order of the table never matters.
 */
export function matchRoute(
  table: readonly RouteDef[],
  method: string,
  pathname: string
): { route: RouteDef; params: RouteParams } | null {
  let best: { route: RouteDef; params: RouteParams } | null = null;
  for (const r of table) {
    if (r.method !== method) continue;
    const params = matchPattern(r.pattern, pathname);
    if (params && (!best || moreSpecific(r.pattern, best.route.pattern))) best = { route: r, params };
  }
  return best;
}

/** Run a matched route. */
export function dispatch(m: { route: RouteDef; params: RouteParams }, req: Request, ctx: ServerContext): Promise<Response> {
  return Promise.resolve(m.route.handler(req, ctx, m.params));
}
