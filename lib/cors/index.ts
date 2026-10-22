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
