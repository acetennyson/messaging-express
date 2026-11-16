import type { ServerContext } from '../core/context';

export function getCorsHeaders(ctx: ServerContext, origin: string | null): Record<string, string> {
  const CORS_ALLOWED_ORIGINS = ctx.config.corsAllowedOrigins;
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-Id, Idempotency-Key, X-Device-Id',
    'Access-Control-Expose-Headers': 'X-Request-Id, Retry-After',
    'Access-Control-Max-Age': '86400',
  };

  if (CORS_ALLOWED_ORIGINS === '*') {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (origin && CORS_ALLOWED_ORIGINS.split(',').includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  return headers;
}

export function handleCorsPreflightRequest(request: Request, ctx: ServerContext): Response {
  const origin = request.headers.get('origin');
  const headers = getCorsHeaders(ctx, origin);

  return new Response(null, {
    status: 204,
    headers,
  });
}

export function addCorsHeaders(ctx: ServerContext, response: Response, origin: string | null): Response {
  const corsHeaders = getCorsHeaders(ctx, origin);

  Object.entries(corsHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });

  return response;
}

/**
 * Wraps a route handler so every response it returns (success or error,
 * from any return path inside it) gets CORS headers attached, without
 * having to touch each individual `return` in the handler.
 *
 * Usage: `export const GET = withCors(requireAuth(handleGET));`
 * Pair with an `OPTIONS` export using `handleCorsPreflightRequest` for
 * the preflight request itself, which never reaches this wrapper.
 */
export function withCors<Args extends unknown[]>(
  handler: (req: Request, ctx: ServerContext, ...args: Args) => Promise<Response>
): (req: Request, ctx: ServerContext, ...args: Args) => Promise<Response> {
  return async (req: Request, ctx: ServerContext, ...args: Args) => {
    const origin = req.headers.get('origin');
    const response = await handler(req, ctx, ...args);
    return addCorsHeaders(ctx, response, origin);
  };
}
