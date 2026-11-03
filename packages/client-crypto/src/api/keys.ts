import { call, type RequestClient } from './transport';
import type { DeviceInfo } from './devices';

export interface KeyEntry { deviceId: string; wrappedKey: string; wrappedByDeviceId: string }
export interface KeyRow { keyVersion: number; wrappedKey: string; wrappedByDeviceId: string; wrappedByPublicKey: string }

/** GET /conversations/:id/keys [Dev]: every key row addressed to the calling device, ordered by keyVersion. */
export const getKeys = (c: RequestClient, conversationId: string, deviceId: string, signal?: AbortSignal) =>
  call<KeyRow[]>(c, 'GET', `/conversations/${encodeURIComponent(conversationId)}/keys`, { deviceId, signal });

/**
 * POST /conversations/:id/keys [Dev]. A new version (latest + 1) must cover exactly the devices of the current participants
 * (StaleDeviceSetError / ParticipantHasNoDeviceError otherwise); an existing version adds wraps for devices that lack one.
 * KeyExistsError when every row was already there (first writer wins). Never retried.
 */
export const uploadKeys = (c: RequestClient, conversationId: string, deviceId: string, input: { keyVersion: number; keys: KeyEntry[] }, signal?: AbortSignal) =>
  call<{ inserted: number }>(c, 'POST', `/conversations/${encodeURIComponent(conversationId)}/keys`, { deviceId, body: input, signal });

/** POST /conversations/:id/keys/request [Dev]: ask the other members' devices to send you the key. 30/min per user. */
export const requestKeys = (c: RequestClient, conversationId: string, deviceId: string, keyVersion?: number, signal?: AbortSignal) =>
  call<{ requested: true }>(c, 'POST', `/conversations/${encodeURIComponent(conversationId)}/keys/request`, {
    deviceId,
    body: keyVersion === undefined ? {} : { keyVersion },
    signal,
  });

/** GET /conversations/:id/devices: the active devices of the conversation's CURRENT participants, in one call (server stage 7.11). */
export const listConversationDevices = (c: RequestClient, conversationId: string, signal?: AbortSignal) =>
  call<DeviceInfo[]>(c, 'GET', `/conversations/${encodeURIComponent(conversationId)}/devices`, { signal });
