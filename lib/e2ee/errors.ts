import { AppError } from '../errors';

/** 403: the route needs an X-Device-Id header and the request has none. */
export class DeviceRequiredError extends AppError {
  constructor() {
    super('This endpoint needs an X-Device-Id header', 403, 'DEVICE_REQUIRED');
  }
}

/** 403: X-Device-Id is not an active device of the token's user (wrong, revoked, or someone else's). */
export class DeviceInvalidError extends AppError {
  constructor() {
    super('X-Device-Id is not an active device of this user', 403, 'DEVICE_INVALID');
  }
}

/** 409: the user already has an active device; further devices are added by linking (or restoring a backup). */
export class DeviceExistsError extends AppError {
  constructor() {
    super('This user already has an active device. Link a new device from an existing one, or restore from a backup.', 409, 'DEVICE_EXISTS');
  }
}

/** 404: no live approval for this public key (not approved yet, expired, already used, or a different key). One code for all. */
export class PairingNotFoundError extends AppError {
  constructor() {
    super('No approved pairing for this public key (it may not be approved yet, or it expired)', 404, 'PAIRING_NOT_FOUND');
  }
}

/** 409: the user already has the maximum number of active devices (MAX_DEVICES_PER_USER). */
export class DeviceLimitError extends AppError {
  constructor(limit: number) {
    super(`This user already has the maximum of ${limit} devices. Revoke one first.`, 409, 'DEVICE_LIMIT');
  }
}
