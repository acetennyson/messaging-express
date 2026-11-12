import { getHostedContext } from './context';
import type { ServerContext } from '../core/context';

/**
 * Edge adapter for the hosted Next.js routes: supplies the env-built context to a handler that requires one.
 * Route files compose `hosted(withCors(requireAuth(handler)))`; nothing below this call reads a global.
 */
export function hosted<Req, Res>(handler: (req: Req, ctx: ServerContext) => Promise<Res>) {
  return (req: Req): Promise<Res> => handler(req, getHostedContext());
}
