import { fromBase64Url, toBase64Url } from '../format/base64url';
import { MalformedResponseError } from './errors';
import { call, type RequestClient } from './transport';

export interface DeviceInfo { id: string; userId: string; publicKey: string; isPrimary: boolean; deviceName: string | null }
export interface RegisteredDevice { id: string; isPrimary: boolean; createdAt: string }
export interface LinkedDevice { id: string; isPrimary: boolean; devices: DeviceInfo[]; conversationIds: string[] }

const MAX_USER_IDS = 50;

/**
 * Device lists decide who gets keys, so a server answer is checked before it is used: every entry needs an id, a user id and a 32-byte
 * public key in base64url, and a device id may appear once. Anything else rejects the whole list (MalformedResponseError).
 */
export function parseDeviceList(raw: unknown): DeviceInfo[] {
  if (!Array.isArray(raw)) throw new MalformedResponseError('device list is not an array');
  const seen = new Set<string>();
  for (const d of raw as Array<Partial<DeviceInfo> | null>) {
    if (!d || typeof d.id !== 'string' || !d.id || typeof d.userId !== 'string' || !d.userId || typeof d.publicKey !== 'string' || typeof d.isPrimary !== 'boolean') throw new MalformedResponseError('device entry has the wrong shape');
    let pk: Uint8Array;
    try { pk = fromBase64Url(d.publicKey); } catch { throw new MalformedResponseError('device public key is not base64url'); }
    if (pk.length !== 32 || toBase64Url(pk) !== d.publicKey) throw new MalformedResponseError('device public key is not 32 bytes in canonical base64url');
    if (seen.has(d.id)) throw new MalformedResponseError('device id listed twice');
    seen.add(d.id);
  }
  return raw as DeviceInfo[];
}

/** POST /devices: register the user's FIRST device (it becomes the primary). 409 DEVICE_EXISTS afterwards: link instead. */
export const registerDevice = (c: RequestClient, input: { publicKey: string; deviceName?: string }, signal?: AbortSignal) =>
  call<RegisteredDevice>(c, 'POST', '/devices', { body: input, signal });

/** GET /devices: active devices of the users. Any number of ids (the server takes 50 per call, so this chunks). Unknown users yield nothing. */
export async function listDevices(c: RequestClient, userIds: string[], signal?: AbortSignal): Promise<DeviceInfo[]> {
  const ids = [...new Set(userIds)];
  const out: DeviceInfo[] = [];
  for (let i = 0; i < ids.length; i += MAX_USER_IDS) {
    out.push(...parseDeviceList(await call<unknown>(c, 'GET', '/devices', { query: { userIds: ids.slice(i, i + MAX_USER_IDS).join(',') }, signal })));
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
