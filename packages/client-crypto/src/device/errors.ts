/** The call is not allowed in the device's current state (for example approving a link from a companion). Nothing was sent. */
export class DeviceStateError extends Error {
  readonly state: string;
  constructor(message: string, state: string) { super(message); this.name = 'DeviceStateError'; this.state = state; }
}
/** This device was revoked (by another device or an admin reset). Its local keys were wiped; register or link again. */
export class DeviceRevokedError extends Error {
  constructor(message = 'This device was revoked. Its local keys were removed.') { super(message); this.name = 'DeviceRevokedError'; }
}
/** completeLink gave up: nobody approved this key before the timeout, or the caller aborted. */
export class LinkTimeoutError extends Error {
  constructor(message = 'The link was not approved in time') { super(message); this.name = 'LinkTimeoutError'; }
}
