import { getHostedContext } from './context';
import type { ServerContext } from '../core/context';

/**
 * Edge adapter for the hosted Next.js routes: supplies the env-built context to a handler that requires one.
 * Route files compose `hosted(withCors(requireAuth(handler)))`; nothing below this call reads a global.
 * Extra arguments Next passes (the dynamic-route `{ params }`) are forwarded after `ctx`.
 */
export function hosted<Req, Rest extends unknown[], Res>(handler: (req: Req, ctx: ServerContext, ...rest: Rest) => Promise<Res> | Res) {
  return (req: Req, ...rest: Rest): Promise<Res> => Promise.resolve(handler(req, getHostedContext(), ...rest));
}
