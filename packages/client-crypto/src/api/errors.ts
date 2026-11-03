// Typed errors for the Stage 7 routes. The core client rejects with MessagingExpressError { status, code, details, retryAfter };
// mapApiError() turns the E2EE codes into the classes below. Duck-typed on purpose: this package never imports the core client at runtime.

/** Base class of every error this layer throws. `code` is the server's error code (or NETWORK_ERROR etc.). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfter?: number;
  constructor(message: string, init: { status: number; code: string; details?: unknown; retryAfter?: number; cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.retryAfter = init.retryAfter;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }
}

/** The server answered 2xx with something that is not the documented shape (for example a device list with a malformed public key). Nothing from that answer is used. */
export class MalformedResponseError extends ApiError { constructor(message: string) { super(message, { status: 0, code: 'MALFORMED_RESPONSE' }); } }
/** 403 DEVICE_REQUIRED: the route needs an X-Device-Id and none was sent. */
export class DeviceRequiredError extends ApiError {}
/** 403 DEVICE_INVALID: the device id is not an active device of this user (revoked, wrong, or someone else's). */
export class DeviceInvalidError extends ApiError {}
/** 409 DEVICE_EXISTS: the user already has a device; link a new one or restore a backup. */
export class DeviceExistsError extends ApiError {}
/** 409 DEVICE_LIMIT: MAX_DEVICES_PER_USER reached. */
export class DeviceLimitError extends ApiError {}
/** 404 PAIRING_NOT_FOUND: not approved yet, expired, already used, or a different key. Poll until expiresAt. */
export class PairingNotFoundError extends ApiError {}
/** 409 STALE_DEVICE_SET: wrap for exactly `deviceIds` and retry. */
export class StaleDeviceSetError extends ApiError {
  readonly deviceIds: string[];
  constructor(message: string, init: ConstructorParameters<typeof ApiError>[1]) {
    super(message, init);
    this.deviceIds = stringArray((init.details as { deviceIds?: unknown } | undefined)?.deviceIds);
  }
}
/** 409 PARTICIPANT_HAS_NO_DEVICE: these users have no active device, so no key can be wrapped for them. */
export class ParticipantHasNoDeviceError extends ApiError {
  readonly userIds: string[];
  constructor(message: string, init: ConstructorParameters<typeof ApiError>[1]) {
    super(message, init);
    this.userIds = stringArray((init.details as { userIds?: unknown } | undefined)?.userIds);
  }
}
/** 409 KEY_EXISTS: someone uploaded these keys first. Fetch the existing keys instead. */
export class KeyExistsError extends ApiError {}
/** 409 KEYS_NOT_READY: no key rows exist for the conversation yet. */
export class KeysNotReadyError extends ApiError {}
/** 409 KEY_ROTATION_REQUIRED: the message's key version is below `minKeyVersion`. */
export class KeyRotationRequiredError extends ApiError {
  readonly minKeyVersion: number;
  constructor(message: string, init: ConstructorParameters<typeof ApiError>[1]) {
    super(message, init);
    const v = (init.details as { minKeyVersion?: unknown } | undefined)?.minKeyVersion;
    this.minKeyVersion = typeof v === 'number' ? v : NaN;
  }
}
/** 404 NOT_FOUND. With the server's E2EE_ENABLED=off every E2EE route answers this. */
export class NotFoundError extends ApiError {}
/** 429 RATE_LIMIT_EXCEEDED (older docs: RATE_LIMITED). `retryAfter` is in seconds when the server sent it. */
export class RateLimitedError extends ApiError {}
/** 400 VALIDATION_ERROR. */
export class ValidationError extends ApiError {}
/** 403 FORBIDDEN (wrong token type, not the primary device, not a participant, ...). */
export class ForbiddenError extends ApiError {}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

type Ctor = new (message: string, init: ConstructorParameters<typeof ApiError>[1]) => ApiError;
const BY_CODE: Record<string, Ctor> = {
  DEVICE_REQUIRED: DeviceRequiredError,
  DEVICE_INVALID: DeviceInvalidError,
  DEVICE_EXISTS: DeviceExistsError,
  DEVICE_LIMIT: DeviceLimitError,
  PAIRING_NOT_FOUND: PairingNotFoundError,
  STALE_DEVICE_SET: StaleDeviceSetError,
  PARTICIPANT_HAS_NO_DEVICE: ParticipantHasNoDeviceError,
  KEY_EXISTS: KeyExistsError,
  KEYS_NOT_READY: KeysNotReadyError,
  KEY_ROTATION_REQUIRED: KeyRotationRequiredError,
  NOT_FOUND: NotFoundError,
  RATE_LIMITED: RateLimitedError,
  RATE_LIMIT_EXCEEDED: RateLimitedError,
  VALIDATION_ERROR: ValidationError,
  FORBIDDEN: ForbiddenError,
};

/** Map whatever the transport threw. Already-mapped ApiErrors and things without a numeric `status` pass through unchanged. */
export function mapApiError(e: unknown): unknown {
  if (e instanceof ApiError) return e;
  if (!e || typeof e !== 'object') return e;
  const o = e as { status?: unknown; code?: unknown; message?: unknown; details?: unknown; retryAfter?: unknown };
  if (typeof o.status !== 'number' || typeof o.code !== 'string') return e;
  const Cls = BY_CODE[o.code] ?? ApiError;
  return new Cls(typeof o.message === 'string' ? o.message : o.code, {
    status: o.status,
    code: o.code,
    details: o.details,
    retryAfter: typeof o.retryAfter === 'number' ? o.retryAfter : undefined,
    cause: e,
  });
}
