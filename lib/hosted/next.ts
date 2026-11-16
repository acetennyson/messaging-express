import { getHostedContext } from './context';
import type { ServerContext } from '../core/context';
import { routes } from '../core/routes';
import { matchPattern, type HttpMethod } from '../core/routing';

/**
 * Edge adapter for the hosted Next.js routes: supplies the env-built context to a handler that requires one.
 * Route files compose `hosted(withCors(requireAuth(handler)))`; nothing below this call reads a global.
 * Extra arguments Next passes (the dynamic-route `{ params }`) are forwarded after `ctx`.
 */
export function hosted<Req, Rest extends unknown[], Res>(handler: (req: Req, ctx: ServerContext, ...rest: Rest) => Promise<Res> | Res) {
  return (req: Req, ...rest: Rest): Promise<Res> => Promise.resolve(handler(req, getHostedContext(), ...rest));
}

/**
 * A Next.js route export: `export const GET = nextRoute('GET', '/api/v1/users')`. Looks the handler up in the shared route
 * table (lib/core/routes) so Next and the Node adapter run the same code, and supplies the env-built context.
 * Next's own `{ params }` argument is ignored: the shared matcher derives params from the URL (decoded once, like Next).
 */
export function nextRoute(method: HttpMethod, pattern: string) {
  const def = routes.find((r) => r.method === method && r.pattern === pattern);
  if (!def) throw new Error(`No route registered for ${method} ${pattern}`);
  return async (req: Request): Promise<Response> => {
    const params = matchPattern(pattern, new URL(req.url).pathname) ?? {};
    return def.handler(req, getHostedContext(), params);
  };
}
