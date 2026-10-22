import { NextRequest } from 'next/server';

const CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS || '*';

export function getCorsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-Id, Idempotency-Key',
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

export function handleCorsPreflightRequest(request: NextRequest): Response {
  const origin = request.headers.get('origin');
  const headers = getCorsHeaders(origin);

  return new Response(null, {
    status: 204,
    headers,
  });
}

export function addCorsHeaders(response: Response, origin: string | null): Response {
  const corsHeaders = getCorsHeaders(origin);

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
  handler: (req: NextRequest, ...args: Args) => Promise<Response>
): (req: NextRequest, ...args: Args) => Promise<Response> {
  return async (req: NextRequest, ...args: Args) => {
    const origin = req.headers.get('origin');
    const response = await handler(req, ...args);
    return addCorsHeaders(response, origin);
  };
}
