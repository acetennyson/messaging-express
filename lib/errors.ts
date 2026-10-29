import { conflictError, errorResponse, validationError } from './http';
import { logger } from './logger';

/**
 * Typed errors for expected failures (Track H2/H3). Handlers throw these, and toErrorResponse maps them to a
 * status code. Anything that is NOT one of these (a database failure, a bug) is, by definition, unexpected and
 * becomes a 500 with a generic message: it must never be reported as the client's fault, and its internal
 * message must never be sent to the client.
 *
 * Relative imports only: lib/auth/project.ts (which throws AuthError) is also compiled by tsconfig.server.json.
 */
export class AppError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}

/** 401: the caller could not be authenticated (missing/invalid token, project or organization inactive). */
export class AuthError extends AppError {
  constructor(message: string) {
    super(message, 401, 'UNAUTHORIZED');
  }
}

/** 403: authenticated, but not allowed to do this (wrong token type, no user in the token, ...). */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', code = 'FORBIDDEN') {
    super(message, 403, code);
  }
}

/** 404: the thing the request refers to does not exist (or is not visible to this project). */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

/** 400: the request is well-formed JSON but violates a rule (same status and code as schema validation). */
export class RequestValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

/** 413: the request body is larger than the server accepts (see lib/request-body.ts, MAX_JSON_BODY_BYTES). */
export class PayloadTooLargeError extends AppError {
  constructor(readonly maxBytes: number) {
    super(`Request body is too large (the limit is ${maxBytes} bytes)`, 413, 'PAYLOAD_TOO_LARGE');
  }
}

export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/**
 * One place that decides status codes for a thrown error:
 *   AppError            -> its own status/code and message (4xx, expected)
 *   ZodError            -> 400 VALIDATION_ERROR (message unchanged from before)
 *   SyntaxError         -> 400 VALIDATION_ERROR (req.json() on a malformed body; message unchanged from before)
 *   Postgres 23503      -> 400 VALIDATION_ERROR (a referenced row does not exist; constraint details are not returned)
 *   Postgres 23505      -> 409 CONFLICT (unique violation; constraint details are not returned)
 *   anything else       -> 500 INTERNAL_ERROR, generic message, full error logged server side
 */
export function toErrorResponse(error: unknown, logLabel: string): Response {
  if (error instanceof AppError) {
    logger.warn(logLabel, { status: error.status, code: error.code, message: error.message });
    return errorResponse(error.message, error.status, error.code, error.details);
  }
  const e = error as { name?: string; message?: string; stack?: string; code?: string } | undefined;
  if (e?.code === '23503') {
    logger.warn(logLabel, { status: 400, pgCode: e.code });
    return validationError('A referenced resource does not exist');
  }
  if (e?.code === '23505') {
    logger.warn(logLabel, { status: 409, pgCode: e.code });
    return conflictError('Resource already exists');
  }
  if (e?.name === 'ZodError' || error instanceof SyntaxError) {
    logger.warn(logLabel, { status: 400, code: 'VALIDATION_ERROR' });
    return validationError(e?.message ?? 'Invalid request');
  }
  logger.error(logLabel, { error: { message: e?.message, stack: e?.stack } });
  return errorResponse(INTERNAL_ERROR_MESSAGE, 500, 'INTERNAL_ERROR');
}
