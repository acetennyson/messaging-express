export interface ApiResponse<T = any> {
  data?: T;
  error?: {
    message: string;
    code?: string;
    details?: any;
  };
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
    nextCursor?: string;
  };
}

export function successResponse<T>(data: T, meta?: ApiResponse['meta'], status = 200): Response {
  return new Response(
    JSON.stringify({ data, ...(meta && { meta }) } as ApiResponse<T>),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
}

export function errorResponse(
  message: string,
  status = 500,
  code?: string,
  details?: any
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        ...(code && { code }),
        ...(details && { details }),
      },
    } as ApiResponse),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
}

export function createdResponse<T>(data: T): Response {
  return successResponse(data, undefined, 201);
}

export function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}

export function validationError(message: string, details?: any): Response {
  return errorResponse(message, 400, 'VALIDATION_ERROR', details);
}

export function notFoundError(message = 'Resource not found'): Response {
  return errorResponse(message, 404, 'NOT_FOUND');
}

export function unauthorizedError(message = 'Unauthorized'): Response {
  return errorResponse(message, 401, 'UNAUTHORIZED');
}

export function forbiddenError(message = 'Forbidden'): Response {
  return errorResponse(message, 403, 'FORBIDDEN');
}

export function conflictError(message: string, details?: any): Response {
  return errorResponse(message, 409, 'CONFLICT', details);
}

export function tooManyRequestsError(retryAfter?: number): Response {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (retryAfter) {
    headers['Retry-After'] = retryAfter.toString();
  }

  return new Response(
    JSON.stringify({
      error: {
        message: 'Too many requests',
        code: 'RATE_LIMIT_EXCEEDED',
      },
    } as ApiResponse),
    {
      status: 429,
      headers,
    }
  );
}
