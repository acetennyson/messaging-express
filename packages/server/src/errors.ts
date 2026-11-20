import type { ServerContext } from './core/context';
import { conflictError, errorResponse, validationError } from './http';

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
  /** Why, for callers (the realtime handshake) that report the two cases differently. Not sent in REST bodies. */
  constructor(message: string, readonly reason: 'invalid_token' | 'project_inactive' | 'rejected' = 'rejected') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

/**
 * 503: authentication could not be decided (the customer's `authenticate()` threw, hung, or returned nonsense).
 * Never a 401: that would tell a client its credentials are wrong when it is our side that is broken. The message is
 * generic on purpose; the real cause is logged, not sent.
 */
export class AuthUnavailableError extends AppError {
  constructor() {
    super('Authentication is temporarily unavailable', 503, 'authentication_unavailable');
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
export function toErrorResponse(ctx: ServerContext, error: unknown, logLabel: string): Response {
  if (error instanceof AppError) {
    ctx.logger.warn(logLabel, { status: error.status, code: error.code, message: error.message });
    return errorResponse(error.message, error.status, error.code, error.details);
  }
  const e = error as { name?: string; message?: string; stack?: string; code?: string } | undefined;
  if (e?.code === '23503') {
    ctx.logger.warn(logLabel, { status: 400, pgCode: e.code });
    return validationError('A referenced resource does not exist');
  }
  if (e?.code === '23505') {
    ctx.logger.warn(logLabel, { status: 409, pgCode: e.code });
    return conflictError('Resource already exists');
  }
  if (e?.name === 'ZodError' || error instanceof SyntaxError) {
    ctx.logger.warn(logLabel, { status: 400, code: 'VALIDATION_ERROR' });
    return validationError(e?.message ?? 'Invalid request');
  }
  ctx.logger.error(logLabel, { error: { message: e?.message, stack: e?.stack } });
  return errorResponse(INTERNAL_ERROR_MESSAGE, 500, 'INTERNAL_ERROR');
}

/** `MessagingServer.init` was given a missing or invalid option. The message names the option. Not an HTTP error. */
export class ConfigError extends Error {
  constructor(readonly option: string, message: string) {
    super(`Invalid option '${option}': ${message}`);
    this.name = 'ConfigError';
  }
}

/** The database does not hold the messaging tables yet (run the migration step first). Not an HTTP error. */
export class SchemaNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaNotReadyError';
  }
}

/** The database was migrated by a newer release than this code. Always refused. Not an HTTP error. */
export class SchemaTooNewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaTooNewError';
  }
}

/** An applied migration step has been edited since it ran. Not an HTTP error. */
export class SchemaChecksumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaChecksumError';
  }
}
