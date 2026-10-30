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

/** 409: the keys sent do not cover exactly the active devices of the conversation's participants. details.deviceIds = the current set. */
export class StaleDeviceSetError extends AppError {
  constructor(deviceIds: string[]) {
    super('The device set changed. Wrap the key for exactly these devices and retry.', 409, 'STALE_DEVICE_SET', { deviceIds });
  }
}

/** 409: a participant has no active device, so no key can be wrapped for them. details.userIds = who. */
export class ParticipantHasNoDeviceError extends AppError {
  constructor(userIds: string[]) {
    super('Some participants have no registered device', 409, 'PARTICIPANT_HAS_NO_DEVICE', { userIds });
  }
}

/** 409: every key row in this upload already exists (first writer wins). The client should fetch the existing keys. */
export class KeyExistsError extends AppError {
  constructor() {
    super('A key for these devices and this key version already exists', 409, 'KEY_EXISTS');
  }
}

/** 409: the message names a key version below the conversation's minimum (a member was removed; the sender must rotate first). */
export class KeyRotationRequiredError extends AppError {
  constructor(minKeyVersion: number) {
    super(`This conversation requires key version ${minKeyVersion} or newer. Fetch the latest key (or rotate) and retry.`, 409, 'KEY_ROTATION_REQUIRED', { minKeyVersion });
  }
}

/** 409: an encrypted conversation has no key rows yet, so nothing can have been encrypted for it. */
export class KeysNotReadyError extends AppError {
  constructor() {
    super('No conversation keys have been uploaded yet for this conversation', 409, 'KEYS_NOT_READY');
  }
}
