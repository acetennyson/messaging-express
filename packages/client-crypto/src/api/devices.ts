import { call, type RequestClient } from './transport';

export interface DeviceInfo { id: string; userId: string; publicKey: string; isPrimary: boolean; deviceName: string | null }
export interface RegisteredDevice { id: string; isPrimary: boolean; createdAt: string }
export interface LinkedDevice { id: string; isPrimary: boolean; devices: DeviceInfo[]; conversationIds: string[] }

const MAX_USER_IDS = 50;

/** POST /devices: register the user's FIRST device (it becomes the primary). 409 DEVICE_EXISTS afterwards: link instead. */
export const registerDevice = (c: RequestClient, input: { publicKey: string; deviceName?: string }, signal?: AbortSignal) =>
  call<RegisteredDevice>(c, 'POST', '/devices', { body: input, signal });

/** GET /devices: active devices of the users. Any number of ids (the server takes 50 per call, so this chunks). Unknown users yield nothing. */
export async function listDevices(c: RequestClient, userIds: string[], signal?: AbortSignal): Promise<DeviceInfo[]> {
  const ids = [...new Set(userIds)];
  const out: DeviceInfo[] = [];
  for (let i = 0; i < ids.length; i += MAX_USER_IDS) {
    out.push(...(await call<DeviceInfo[]>(c, 'GET', '/devices', { query: { userIds: ids.slice(i, i + MAX_USER_IDS).join(',') }, signal })));
  }
  return out;
}

/** DELETE /devices/:id: revoke one of the caller's own devices (itself included). */
export const revokeDevice = (c: RequestClient, deviceId: string, signal?: AbortSignal) =>
  call<{ id: string; revokedAt: string }>(c, 'DELETE', `/devices/${encodeURIComponent(deviceId)}`, { signal });

/** POST /devices/pair [Dev, primary only]: approve the NEW device's public key. Valid until `expiresAt`. */
export const pairDevice = (c: RequestClient, deviceId: string, publicKey: string, signal?: AbortSignal) =>
  call<{ expiresAt: string }>(c, 'POST', '/devices/pair', { deviceId, body: { publicKey }, signal });

/** POST /devices/link: the new device claims its approval. 404 PairingNotFoundError until the primary approves; poll until expiresAt. */
export const linkDevice = (c: RequestClient, input: { publicKey: string; deviceName?: string }, signal?: AbortSignal) =>
  call<LinkedDevice>(c, 'POST', '/devices/link', { body: input, signal });

/** POST /users/:userId/devices/reset (admin or api token): revoke every device of the user. */
export const resetUserDevices = (c: RequestClient, userId: string, signal?: AbortSignal) =>
  call<{ revoked: number }>(c, 'POST', `/users/${encodeURIComponent(userId)}/devices/reset`, { signal });
