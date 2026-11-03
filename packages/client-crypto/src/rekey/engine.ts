import type { CryptoProvider } from '../crypto/provider';
import { nobleProvider } from '../crypto/noble';
import type { CryptoKeyStore } from '../keystore/types';
import { keyNames } from '../keystore/scope';
import type { RequestClient } from '../api/transport';
import type { DeviceInfo } from '../api/devices';
import { listConversationDevices, uploadKeys } from '../api/keys';
import { KeyExistsError, StaleDeviceSetError, ValidationError } from '../api/errors';
import type { DeviceManager } from '../device/manager';
import type { SecureMessaging } from '../messaging/secure';
import { newConversationKey } from '../envelope/conversationKey';
import { wrapKeyForDevices } from '../envelope/wrap';

/** The part of the core realtime client this needs: `createRealtime(...)` from @messaging-express/client/realtime fits as is. */
export interface EventSource { on(event: string, handler: (data: unknown) => void): () => void }

export type DeviceTrust = 'auto' | 'confirm';
export type LinkedDeviceHistory = 'all' | 'latest' | 'none';
export interface DeviceChange {
  userId: string; deviceId: string; publicKey: string; conversationIds: string[];
  /** wrapped: this device now holds keys from us. pending: waiting for approveDevice() (deviceTrust "confirm"). */
  status: 'wrapped' | 'pending'; own: boolean;
}
export interface RekeyOptions {
  client: RequestClient; device: DeviceManager; secure: SecureMessaging; keyStore: CryptoKeyStore; userId: string; provider?: CryptoProvider;
  /** "auto" (default): give keys to every new device of a participant at once and tell the app. "confirm": other users' new devices wait for approveDevice(id). Your own devices are never held back. */
  deviceTrust?: DeviceTrust;
  /** Which key versions a new device receives: "all" (default: it can read history), "latest" (only the newest), "none" (only keys created after it joined). */
  linkedDeviceHistory?: LinkedDeviceHistory;
  /** Random delay 0..jitterMs before acting on an event, so many members do not all upload at once. Default 2000. */
  jitterMs?: number;
  /** How long the pre-send device check is reused per conversation. Default 30000. */
  piggybackTtlMs?: number;
  random?: () => number; sleep?: (ms: number) => Promise<void>; now?: () => number;
}

const MAX_ROTATE_ATTEMPTS = 3;
type Known = Record<string, string[]>;

export function createRekeyEngine(o: RekeyOptions) {
  const { client, device, secure, keyStore, userId } = o;
  const provider = o.provider ?? nobleProvider;
  const trust: DeviceTrust = o.deviceTrust ?? 'auto';
  const history: LinkedDeviceHistory = o.linkedDeviceHistory ?? 'all';
  const jitterMs = o.jitterMs ?? 2000;
  const ttl = o.piggybackTtlMs ?? 30_000;
  const random = o.random ?? Math.random;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());

  const inflight = new Map<string, Promise<unknown>>();
  const running = new Set<Promise<unknown>>();
  const changeHandlers = new Set<(c: DeviceChange) => void>();
  const errorHandlers = new Set<(e: { event: string; error: unknown }) => void>();
  const pending = new Map<string, DeviceChange>();
  const checked = new Map<string, number>();

  // ---- who is trusted (per conversation, persisted) ----
  let known: Known | null = null;
  async function loadKnown(): Promise<Known> {
    if (known) return known;
    try { const raw = await keyStore.get(keyNames.knownDevices); known = raw ? (JSON.parse(new TextDecoder().decode(raw)) as Known) : {}; } catch { known = {}; }
    return known;
  }
  async function saveKnown() { await keyStore.set(keyNames.knownDevices, new TextEncoder().encode(JSON.stringify(known ?? {}))); }
  async function markKnown(conv: string, ids: string[]) {
    const k = await loadKnown();
    const set = new Set(k[conv] ?? []);
    let changed = !k[conv];
    for (const id of ids) if (!set.has(id)) { set.add(id); changed = true; }
    if (changed) { k[conv] = [...set]; await saveKnown(); }
  }

  const emitChange = (c: DeviceChange) => { for (const h of changeHandlers) { try { h(c); } catch { /* app handler errors are the app's */ } } };
  const emitError = (event: string, error: unknown) => { for (const h of errorHandlers) { try { h({ event, error }); } catch { /* */ } } };
  function track<T>(key: string, fn: () => Promise<T>, event: string): Promise<T | undefined> {
    const existing = inflight.get(key) as Promise<T | undefined> | undefined;
    if (existing) return existing; // the same (conversation, device) is already being handled: dedupe
    const p = (async () => { try { return await fn(); } catch (e) { emitError(event, e); return undefined; } finally { inflight.delete(key); } })();
    inflight.set(key, p); running.add(p); void p.finally(() => running.delete(p));
    return p;
  }
  const jitter = () => (jitterMs > 0 ? sleep(Math.floor(random() * jitterMs)) : Promise.resolve());

  const members = async (conv: string): Promise<DeviceInfo[]> => listConversationDevices(client, conv);
  async function held(conv: string): Promise<Array<{ version: number; key: Uint8Array }>> {
    const out: Array<{ version: number; key: Uint8Array }> = [];
    for (const v of await secure.heldVersions(conv)) { const key = await keyStore.get(keyNames.conversationKey(conv, v)); if (key) out.push({ version: v, key }); }
    return out;
  }
  const versionsFor = <T extends { version: number }>(all: T[], only?: number): T[] => {
    if (only !== undefined) return all.filter((h) => h.version === only);
    return history === 'all' ? all : history === 'latest' ? all.slice(-1) : [];
  };

  /** Wrap the held keys (per policy) for these devices and upload them. KEY_EXISTS and a device that left meanwhile are expected and ignored. */
  async function wrapFor(conv: string, targets: DeviceInfo[], only?: number): Promise<number> {
    const me = await device.requireDevice();
    const to = targets.filter((t) => t.id !== me.deviceId);
    if (!to.length) return 0;
    let inserted = 0;
    for (const h of versionsFor(await held(conv), only)) {
      const keys = wrapKeyForDevices({ conversationKey: h.key, conversationId: conv, keyVersion: h.version, sender: { deviceId: me.deviceId, privateKey: me.privateKey }, recipients: to.map((t) => ({ deviceId: t.id, publicKey: t.publicKey })), provider });
      try { inserted += (await device.withDevice((d) => uploadKeys(client, conv, d.deviceId, { keyVersion: h.version, keys }))).inserted; }
      catch (e) { if (e instanceof KeyExistsError || e instanceof ValidationError) continue; throw e; }
    }
    return inserted;
  }

  /** Decide for a device I have not seen: give it keys now, or hold it for approval. Always tells the app once. */
  async function admit(conv: string, d: DeviceInfo, convs: string[], onlyVersion?: number): Promise<void> {
    const k = await loadKnown();
    const own = d.userId === userId;
    if (!k[conv]) { // first sight of this conversation: trust the devices already here (trust on first use), judge only the new one
      await markKnown(conv, (await members(conv)).filter((x) => x.id !== d.id).map((x) => x.id));
    }
    const isKnown = (known![conv] ?? []).includes(d.id);
    if (isKnown || own || trust === 'auto') {
      await wrapFor(conv, [d], onlyVersion);
      await markKnown(conv, [d.id]);
      if (!isKnown && !pending.has(d.id)) emitChange({ userId: d.userId, deviceId: d.id, publicKey: d.publicKey, conversationIds: convs, status: 'wrapped', own });
    } else if (!pending.has(d.id)) {
      const change: DeviceChange = { userId: d.userId, deviceId: d.id, publicKey: d.publicKey, conversationIds: convs, status: 'pending', own };
      pending.set(d.id, change);
      emitChange(change);
    } else if (!pending.get(d.id)!.conversationIds.includes(conv)) pending.get(d.id)!.conversationIds.push(conv);
  }

  async function rotate(conv: string, hint: { minKeyVersion?: number } = {}): Promise<{ version: number; rotated: boolean }> {
    for (let attempt = 1; ; attempt++) {
      await secure.refreshKeys(conv).catch(() => undefined); // somebody may have rotated already: adopt it
      const newest = (await secure.heldVersions(conv)).pop() ?? 0;
      if (hint.minKeyVersion !== undefined && newest >= hint.minKeyVersion) return { version: newest, rotated: false };
      const me = await device.requireDevice();
      const devs = await members(conv);
      const version = newest + 1, ck = newConversationKey(provider);
      const keys = wrapKeyForDevices({ conversationKey: ck, conversationId: conv, keyVersion: version, sender: { deviceId: me.deviceId, privateKey: me.privateKey }, recipients: devs.map((d) => ({ deviceId: d.id, publicKey: d.publicKey })), provider });
      try {
        await device.withDevice((d) => uploadKeys(client, conv, d.deviceId, { keyVersion: version, keys }));
        await keyStore.set(keyNames.conversationKey(conv, version), ck);
        await markKnown(conv, devs.map((d) => d.id));
        return { version, rotated: true };
      } catch (e) {
        if (e instanceof KeyExistsError) { await secure.refreshKeys(conv); return { version: (await secure.heldVersions(conv)).pop() ?? version, rotated: false }; } // lost the race: adopt the winner
        if (e instanceof StaleDeviceSetError && attempt < MAX_ROTATE_ATTEMPTS) continue;
        throw e;
      }
    }
  }

  // ---- event handlers ----
  const asObj = (d: unknown) => (d && typeof d === 'object' ? (d as Record<string, unknown>) : {});
  async function onDeviceAdded(raw: unknown) {
    const d = asObj(raw);
    const deviceId = String(d.deviceId ?? ''), convs = Array.isArray(d.conversationIds) ? d.conversationIds.map(String) : [];
    const me = await device.currentDevice();
    if (!deviceId || deviceId === me?.deviceId) return;
    for (const conv of convs) {
      if (!(await secure.heldVersions(conv)).length) continue; // nothing to give
      await track(`wrap|${conv}|${deviceId}`, async () => {
        await jitter();
        const target = (await members(conv)).find((x) => x.id === deviceId);
        if (target) await admit(conv, target, convs);
      }, 'device.added');
    }
  }
  async function onKeysUpdated(raw: unknown) {
    const d = asObj(raw);
    const me = await device.currentDevice();
    if (me && Array.isArray(d.deviceIds) && d.deviceIds.includes(me.deviceId) && typeof d.conversationId === 'string') await secure.refreshKeys(d.conversationId);
  }
  async function onKeysRequested(raw: unknown) {
    const d = asObj(raw);
    const conv = String(d.conversationId ?? ''), dev = String(d.requestingDeviceId ?? '');
    const version = typeof d.keyVersion === 'number' ? d.keyVersion : undefined;
    if (!conv || !dev || !(await secure.heldVersions(conv)).length) return;
    await track(`req|${conv}|${dev}`, async () => {
      await jitter();
      const target = (await members(conv)).find((x) => x.id === dev); // must be an active device of a current participant
      if (!target) return;
      const k = await loadKnown();
      if (!k[conv]) await markKnown(conv, (await members(conv)).filter((x) => x.id !== dev).map((x) => x.id));
      const allowed = (known![conv] ?? []).includes(dev) || target.userId === userId || trust === 'auto';
      if (!allowed) { await admit(conv, target, [conv]); return; }
      await wrapFor(conv, [target], version);
      await markKnown(conv, [dev]);
    }, 'keys.requested');
  }
  async function onParticipantAdded(raw: unknown) {
    const d = asObj(raw);
    const conv = String(d.conversationId ?? ''), who = String(d.userId ?? '');
    if (!conv || who === userId || !(await secure.heldVersions(conv)).length) return;
    await track(`add|${conv}|${who}`, async () => {
      await jitter();
      for (const t of (await members(conv)).filter((x) => x.userId === who)) await admit(conv, t, [conv]);
    }, 'participant.added');
  }
  async function onParticipantRemoved(raw: unknown) {
    const d = asObj(raw);
    const conv = String(d.conversationId ?? '');
    if (!conv || String(d.userId) === userId) { checked.delete(conv); return; } // I was removed: nothing to rotate for me
    await track(`rotate|${conv}`, async () => { await jitter(); await rotate(conv, { minKeyVersion: typeof d.minKeyVersion === 'number' ? d.minKeyVersion : undefined }); checked.delete(conv); }, 'participant.removed');
  }
  async function onDeviceRemoved(raw: unknown) {
    const d = asObj(raw);
    for (const c of Array.isArray(d.conversationIds) ? d.conversationIds : []) checked.delete(String(c));
    const me = await device.currentDevice();
    if (me && d.deviceId === me.deviceId) await device.listDevices(); // surfaces DeviceRevokedError and wipes local state
  }

  const handlers: Record<string, (d: unknown) => Promise<void>> = {
    'device.added': onDeviceAdded, 'device.removed': onDeviceRemoved, 'keys.updated': onKeysUpdated, 'keys.requested': onKeysRequested,
    'participant.added': onParticipantAdded, 'participant.removed': onParticipantRemoved,
  };
  /** Feed one event by hand (tests, or a transport other than the core realtime client). Resolves when it has been handled. */
  async function handle(event: string, data: unknown): Promise<void> {
    const h = handlers[event];
    if (!h) return;
    try { await h(data); } catch (e) { emitError(event, e); }
  }

  /** The pre-send check: if a participant has a device I have not given keys to, do it now. Reuses one answer per conversation for `piggybackTtlMs`. */
  async function checkBeforeSend(conv: string, force = false): Promise<void> {
    const last = checked.get(conv);
    if (!force && last !== undefined && now() - last < ttl) return;
    const devs = await members(conv);
    checked.set(conv, now());
    const k = await loadKnown();
    if (!k[conv]) { // first sight: trust who is here (trust on first use) and make sure they all hold the keys
      await markKnown(conv, devs.map((d) => d.id));
      await wrapFor(conv, devs);
      return;
    }
    for (const d of devs) if (!(known![conv] ?? []).includes(d.id)) await admit(conv, d, [conv]);
    // trusted devices that may still lack a wrap (an event was lost): uploading is idempotent (409 KEY_EXISTS is ignored)
    await wrapFor(conv, devs.filter((d) => (known![conv] ?? []).includes(d.id)));
  }
  secure.setBeforeSend(checkBeforeSend);

  function start(events: EventSource): () => void {
    const offs = Object.keys(handlers).map((name) => events.on(name, (d) => { void handle(name, d); }));
    return () => offs.forEach((off) => off());
  }

  return {
    start, handle, rotate, checkBeforeSend,
    /** Wrap the held keys for these devices now (per the history policy). */
    wrapForDevices: wrapFor,
    onDeviceChange(cb: (c: DeviceChange) => void) { changeHandlers.add(cb); return () => { changeHandlers.delete(cb); }; },
    onError(cb: (e: { event: string; error: unknown }) => void) { errorHandlers.add(cb); return () => { errorHandlers.delete(cb); }; },
    pendingDevices: () => [...pending.values()],
    /** deviceTrust "confirm": give a held-back device its keys. */
    async approveDevice(deviceId: string): Promise<void> {
      const p = pending.get(deviceId);
      if (!p) return;
      for (const conv of p.conversationIds) {
        const target = (await members(conv)).find((x) => x.id === deviceId);
        if (target) { await wrapFor(conv, [target]); await markKnown(conv, [deviceId]); }
      }
      pending.delete(deviceId);
      emitChange({ ...p, status: 'wrapped' });
    },
    rejectDevice(deviceId: string): void { pending.delete(deviceId); },
    /** Resolves when every event being handled has finished (tests, graceful shutdown). */
    async idle(): Promise<void> { while (running.size) await Promise.allSettled([...running]); },
  };
}
export type RekeyEngine = ReturnType<typeof createRekeyEngine>;
