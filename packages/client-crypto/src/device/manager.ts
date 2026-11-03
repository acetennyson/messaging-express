import type { CryptoKeyStore } from '../keystore/types';
import type { CryptoProvider } from '../crypto/provider';
import { nobleProvider } from '../crypto/noble';
import { keyNames } from '../keystore/scope';
import { fromBase64Url, toBase64Url } from '../format/base64url';
import type { RequestClient } from '../api/transport';
import { DeviceInvalidError, PairingNotFoundError, RateLimitedError, mapApiError } from '../api/errors';
import { linkDevice, listDevices, pairDevice, registerDevice, revokeDevice, type DeviceInfo } from '../api/devices';
import { DeviceRevokedError, DeviceStateError, LinkTimeoutError } from './errors';
import { confirmationCodeFor, linkCodeFor, linkQrPayload, parseLinkInput } from './linkCode';

export type DeviceState = 'unregistered' | 'linking' | 'primary' | 'companion' | 'revoked';

export interface DeviceIdentity { deviceId: string; publicKey: string; role: 'primary' | 'companion' }
export interface LocalDevice extends DeviceIdentity { privateKey: Uint8Array }
export interface LinkOffer { publicKey: string; qrPayload: string; linkCode: string; confirmationCode: string }
export interface LinkApproval { publicKey: string; confirmationCode: string; confirm(): Promise<{ expiresAt: string }> }
export interface DeviceManagerOptions {
  client: RequestClient;
  keyStore: CryptoKeyStore;
  /** The signed-in user's id. Needed to list this user's devices and to notice a revocation. */
  userId: string;
  provider?: CryptoProvider;
  /** Test seam: wait this long (ms). Default setTimeout. Must reject if the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}
export interface CompleteLinkOptions {
  deviceName?: string;
  /** Poll interval, default 2000 (the server allows 40 link calls a minute). */
  pollIntervalMs?: number;
  /** Give up after this long, default 120000. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const encodeJson = (o: unknown) => enc.encode(JSON.stringify(o));

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new LinkTimeoutError('aborted'));
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new LinkTimeoutError('aborted')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

interface StoredDevice { v: 1; deviceId: string; privateKey: string; publicKey: string; role: 'primary' | 'companion' }
interface StoredPending { v: 1; privateKey: string; publicKey: string }

/**
 * The device lifecycle on one device: register the first device, link further ones, list, revoke. State lives in the key store, so it
 * survives restarts: unregistered -> (linking ->) primary | companion -> revoked. Misuse fails here with DeviceStateError, before any request.
 */
export function createDeviceManager(opts: DeviceManagerOptions) {
  const { client, keyStore, userId } = opts;
  const provider = opts.provider ?? nobleProvider;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  if (!client || !keyStore || !userId) throw new TypeError('createDeviceManager: client, keyStore and userId are required');

  async function readJson<T extends { v: number }>(name: string): Promise<T | null> {
    const raw = await keyStore.get(name);
    if (!raw) return null;
    try {
      const o = JSON.parse(dec.decode(raw));
      return o && o.v === 1 ? (o as T) : null;
    } catch { return null; }
  }
  const readDevice = () => readJson<StoredDevice>(keyNames.device);
  const readPending = () => readJson<StoredPending>(keyNames.devicePending);

  async function state(): Promise<DeviceState> {
    const d = await readDevice();
    if (d) return d.role;
    if (await readPending()) return 'linking';
    if (await keyStore.get(keyNames.deviceRevoked)) return 'revoked';
    return 'unregistered';
  }

  async function wipeLocal() {
    await keyStore.delete(keyNames.device);
    await keyStore.delete(keyNames.devicePending);
    for (const k of await keyStore.list('ck/')) await keyStore.delete(k);
    await keyStore.set(keyNames.deviceRevoked, new Uint8Array([1]));
  }
  async function markRevoked(): Promise<never> {
    await wipeLocal();
    throw new DeviceRevokedError();
  }
  async function saveDevice(deviceId: string, kp: { privateKey: Uint8Array; publicKey: Uint8Array }, role: 'primary' | 'companion') {
    const rec: StoredDevice = { v: 1, deviceId, privateKey: toBase64Url(kp.privateKey), publicKey: toBase64Url(kp.publicKey), role };
    await keyStore.set(keyNames.device, encodeJson(rec));
    await keyStore.delete(keyNames.devicePending);
    await keyStore.delete(keyNames.deviceRevoked);
  }
  async function pendingKeyPair(): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
    const p = await readPending();
    if (p) return { privateKey: fromBase64Url(p.privateKey), publicKey: fromBase64Url(p.publicKey) };
    const kp = provider.generateKeyPair();
    await keyStore.set(keyNames.devicePending, encodeJson({ v: 1, privateKey: toBase64Url(kp.privateKey), publicKey: toBase64Url(kp.publicKey) } satisfies StoredPending));
    return kp;
  }
  function need(s: DeviceState, allowed: DeviceState[], what: string) {
    if (!allowed.includes(s)) throw new DeviceStateError(`${what} is not possible while the device is "${s}"`, s);
  }

  /** Run a call that sends X-Device-Id. A DeviceInvalidError means this device was revoked: wipe local state and throw DeviceRevokedError. */
  async function withDevice<T>(fn: (d: LocalDevice) => Promise<T>): Promise<T> {
    const d = await requireDevice();
    try {
      return await fn(d);
    } catch (e) {
      if (mapApiError(e) instanceof DeviceInvalidError) return markRevoked();
      throw e;
    }
  }
  /** The local identity (with the private key), or DeviceStateError when this device is not registered/linked. */
  async function requireDevice(): Promise<LocalDevice> {
    const d = await readDevice();
    if (!d) throw new DeviceStateError('This device is not registered', await state());
    return { deviceId: d.deviceId, publicKey: d.publicKey, role: d.role, privateKey: fromBase64Url(d.privateKey) };
  }

  return {
    state,
    /** This device's identity without the private key, or null. */
    async currentDevice(): Promise<DeviceIdentity | null> {
      const d = await readDevice();
      return d ? { deviceId: d.deviceId, publicKey: d.publicKey, role: d.role } : null;
    },
    requireDevice,
    withDevice,

    /** First device of this user. It becomes the primary. DeviceExistsError (409) when the user already has one: link instead. */
    async registerPrimaryDevice(o: { deviceName?: string } = {}): Promise<DeviceIdentity> {
      need(await state(), ['unregistered', 'linking', 'revoked'], 'Registering');
      const kp = await pendingKeyPair(); // stored first, so a crash between the request and the save cannot lose the key
      const publicKey = toBase64Url(kp.publicKey);
      const res = await registerDevice(client, { publicKey, deviceName: o.deviceName });
      await saveDevice(res.id, kp, 'primary');
      return { deviceId: res.id, publicKey, role: 'primary' };
    },

    /**
     * Adopt an identity that already exists on the server (restore from a backup). Only on a device with no identity: unregistered, linking
     * or revoked. The caller (the backup manager) has already checked the server knows this device and its key.
     */
    async importDevice(d: { deviceId: string; privateKey: Uint8Array; publicKey: Uint8Array; role: 'primary' | 'companion' }): Promise<DeviceIdentity> {
      need(await state(), ['unregistered', 'linking', 'revoked'], 'Restoring a device identity');
      await saveDevice(d.deviceId, d, d.role);
      return { deviceId: d.deviceId, publicKey: toBase64Url(d.publicKey), role: d.role };
    },

    /** On the NEW device: make a key pair and the codes to show. Show qrPayload (or linkCode) to the primary, then call completeLink. */
    async beginLink(): Promise<LinkOffer> {
      need(await state(), ['unregistered', 'linking', 'revoked'], 'Starting a link');
      const kp = await pendingKeyPair();
      return { publicKey: toBase64Url(kp.publicKey), qrPayload: linkQrPayload(kp.publicKey), linkCode: linkCodeFor(kp.publicKey), confirmationCode: confirmationCodeFor(kp.publicKey, provider) };
    },

    /** On the new device: poll until the primary approves (PairingNotFoundError means "not yet"), then store the identity. */
    async completeLink(o: CompleteLinkOptions = {}) {
      need(await state(), ['linking'], 'Completing a link');
      const kp = await pendingKeyPair();
      const publicKey = toBase64Url(kp.publicKey);
      const interval = o.pollIntervalMs ?? 2000;
      const deadline = now() + (o.timeoutMs ?? 120_000);
      for (;;) {
        if (o.signal?.aborted) throw new LinkTimeoutError('aborted');
        try {
          const res = await linkDevice(client, { publicKey, deviceName: o.deviceName }, o.signal);
          await saveDevice(res.id, kp, 'companion');
          return { deviceId: res.id, devices: res.devices, conversationIds: res.conversationIds };
        } catch (e) {
          if (e instanceof PairingNotFoundError) {
            if (now() + interval > deadline) throw new LinkTimeoutError();
            await sleep(interval, o.signal);
          } else if (e instanceof RateLimitedError) {
            const wait = Math.max(interval, (e.retryAfter ?? 0) * 1000);
            if (now() + wait > deadline) throw new LinkTimeoutError();
            await sleep(wait, o.signal);
          } else throw e;
        }
      }
    },

    /** Throw the half-made link away (and its key pair). */
    async cancelLink(): Promise<void> {
      if ((await state()) === 'linking') await keyStore.delete(keyNames.devicePending);
    },

    /**
     * On the PRIMARY: read what the new device showed. Returns the confirmation code for the UI; nothing is sent until the app calls confirm().
     * Only the primary may approve.
     */
    async approveLink(input: string): Promise<LinkApproval> {
      need(await state(), ['primary'], 'Approving a link');
      const key = parseLinkInput(input);
      const publicKey = toBase64Url(key);
      return {
        publicKey,
        confirmationCode: confirmationCodeFor(key, provider),
        confirm: () => withDevice((d) => pairDevice(client, d.deviceId, publicKey)),
      };
    },

    /**
     * This user's active devices. Also how a revocation is noticed: if this device is no longer listed, local state is wiped and
     * DeviceRevokedError is thrown. Keeps the stored role in step with the server (the oldest companion becomes primary when the primary goes).
     */
    async listDevices(): Promise<DeviceInfo[]> {
      const d = await readDevice();
      const list = await listDevices(client, [userId]);
      if (d) {
        const me = list.find((x) => x.id === d.deviceId);
        if (!me) return markRevoked();
        const role = me.isPrimary ? 'primary' : 'companion';
        if (role !== d.role) await keyStore.set(keyNames.device, encodeJson({ ...d, role } satisfies StoredDevice));
      }
      return list;
    },

    /** Revoke one of this user's devices. Revoking this device wipes local keys and leaves state "revoked". */
    async revokeDevice(deviceId: string): Promise<{ id: string; revokedAt: string }> {
      const d = await readDevice();
      const res = await revokeDevice(client, deviceId);
      if (d && d.deviceId === deviceId) await wipeLocal();
      return res;
    },
  };
}

export type DeviceManager = ReturnType<typeof createDeviceManager>;
