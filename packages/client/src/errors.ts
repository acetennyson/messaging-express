/**
 * Every failed API call rejects with this. `status` 0 means the request never got an answer (network error).
 * `code` is the server's error code ("VALIDATION_ERROR", "RATE_LIMIT_EXCEEDED", ...) or "NETWORK_ERROR".
 */
export class MessagingExpressError extends Error {
  readonly status: number;
  readonly code: string;
  /** Seconds the server asked you to wait (429 and some 503s). */
  readonly retryAfter?: number;
  readonly details?: unknown;

  constructor(
    message: string,
    init: { status: number; code: string; retryAfter?: number; details?: unknown; cause?: unknown }
  ) {
    super(message);
    this.name = 'MessagingExpressError';
    this.status = init.status;
    this.code = init.code;
    this.retryAfter = init.retryAfter;
    this.details = init.details;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }
}

/** Seconds from a Retry-After header (delta-seconds or HTTP date), or undefined. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs;
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - now) / 1000));
  return undefined;
}

/** Build the error for a non-2xx response body (the server answers `{ error: { message, code, details? } }`). */
export function errorFromResponse(status: number, bodyText: string, retryAfter?: number): MessagingExpressError {
  let message = `Request failed (HTTP ${status})`;
  let code = 'HTTP_ERROR';
  let details: unknown;
  try {
    const err = JSON.parse(bodyText)?.error;
    if (err && typeof err === 'object') {
      if (typeof err.message === 'string' && err.message) message = err.message;
      if (typeof err.code === 'string' && err.code) code = err.code;
      details = err.details;
    }
  } catch {
    /* not JSON: keep the generic message */
  }
  return new MessagingExpressError(message, { status, code, retryAfter, details });
}
