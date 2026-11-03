import type { CryptoProvider } from '../crypto/provider';
import { nobleProvider } from '../crypto/noble';
import type { CryptoKeyStore } from '../keystore/types';
import { keyNames } from '../keystore/scope';
import type { RequestClient } from '../api/transport';
import { getKeys, requestKeys } from '../api/keys';
import { listDevices } from '../api/devices';
import { createEncryptedConversation, postEncryptedMessage, type E2eeConversation } from '../api/conversations';
import { KeyRotationRequiredError, ParticipantHasNoDeviceError, StaleDeviceSetError } from '../api/errors';
import type { DeviceManager } from '../device/manager';
import { newConversationKey } from '../envelope/conversationKey';
import { unwrapKey, wrapKeyForDevices } from '../envelope/wrap';
import { decryptSecureMessage, encryptSecureMessage } from '../envelope/message';
import { decryptAttachment, encryptAttachment, type AttachmentDescriptor } from '../envelope/attachment';
import { FormatError } from '../format/errors';
import { ConversationIdNotSupportedError, KeyUnavailableError } from './errors';

/** Uploads an opaque blob and returns where it lives. The default uses `client.uploads.uploadOne(blob, { category: 'e2ee' })`. */
export type Uploader = (blob: Blob) => Promise<{ url: string; sizeBytes?: number }>;
/** Fetches the bytes of an uploaded object. The default is `fetch(url)`. */
export type Downloader = (url: string) => Promise<Uint8Array>;

export interface SecureMessagingOptions {
  client: RequestClient & { uploads?: { uploadOne(file: Blob, options?: { category?: string }): Promise<{ ok: true; attachment: { url: string; sizeBytes?: number } } | { ok: false; error: string }> } };
  device: DeviceManager;
  keyStore: CryptoKeyStore;
  userId: string;
  provider?: CryptoProvider;
  uploader?: Uploader;
  download?: Downloader;
  now?: () => number;
}

export interface AttachmentInput { data: Uint8Array | Blob; name: string; type: string; w?: number; h?: number }
/** Fields of a message row the server returns (snake_case) that this layer reads. */
export interface ServerMessage {
  id: string; conversation_id: string; sender_id: string; content: string | null; created_at?: string;
  metadata?: Record<string, unknown> | null; attachments?: Array<{ url: string }> | null;
}
export interface DecryptedAttachment { descriptor: AttachmentDescriptor; url: string }
export interface DecryptedMessage { id: string; conversationId: string; senderId: string; text: string; attachments: DecryptedAttachment[]; createdAt?: string; keyVersion: number }
export type DecryptOutcome = { ok: true; message: DecryptedMessage } | { ok: false; id: string; error: unknown };

const REQUEST_EVERY_MS = 60_000;
const MAX_CREATE_ATTEMPTS = 3;

function uuidv4(p: CryptoProvider): string {
  const b = p.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function createSecureMessaging(o: SecureMessagingOptions) {
  const { client, device, keyStore, userId } = o;
  const provider = o.provider ?? nobleProvider;
  const now = o.now ?? (() => Date.now());
  const lastRequest = new Map<string, number>();
  let beforeSend: ((conversationId: string) => Promise<void>) | null = null;

  const uploader: Uploader = o.uploader ?? (async (blob) => {
    if (!client.uploads) throw new TypeError('No uploader: pass `uploader` to withCrypto, or use a client with `uploads`');
    const r = await client.uploads.uploadOne(blob, { category: 'e2ee' });
    if (!r.ok) throw new Error(`Upload failed: ${r.error}`);
    return r.attachment;
  });
  const download: Downloader = o.download ?? (async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  });

  const versionsOf = async (conversationId: string): Promise<number[]> =>
    (await keyStore.list(keyNames.conversationKeyPrefix(conversationId))).map((k) => Number(k.slice(keyNames.conversationKeyPrefix(conversationId).length))).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);

  /** Fetch every key row for this device, open the ones not cached yet, cache them. Returns the first unwrap failure, if any. */
  async function refresh(conversationId: string): Promise<unknown> {
    const rows = await device.withDevice((d) => getKeys(client, conversationId, d.deviceId));
    const me = await device.requireDevice();
    let firstError: unknown;
    for (const r of rows) {
      const name = keyNames.conversationKey(conversationId, r.keyVersion);
      if (await keyStore.get(name)) continue;
      try {
        const ck = unwrapKey({ wrappedKey: r.wrappedKey, conversationId, keyVersion: r.keyVersion, wrappedByDeviceId: r.wrappedByDeviceId, senderPublicKey: r.wrappedByPublicKey, recipient: { deviceId: me.deviceId, privateKey: me.privateKey }, provider });
        await keyStore.set(name, ck);
      } catch (e) { firstError ??= e; }
    }
    return firstError;
  }
  async function ask(conversationId: string, keyVersion: number | null): Promise<boolean> {
    const k = `${conversationId}|${keyVersion ?? ''}`;
    const t = now();
    if (t - (lastRequest.get(k) ?? -Infinity) < REQUEST_EVERY_MS) return false;
    lastRequest.set(k, t);
    try { await device.withDevice((d) => requestKeys(client, conversationId, d.deviceId, keyVersion ?? undefined)); return true; } catch { return false; }
  }
  /** The key for (conversation, version); `null` version = the newest this device has. Fetches when missing; fires one keys/request when still missing. */
  async function keyFor(conversationId: string, version: number | null): Promise<{ key: Uint8Array; version: number }> {
    const have = async () => { const v = version ?? (await versionsOf(conversationId)).pop(); return v === undefined ? null : { v, key: await keyStore.get(keyNames.conversationKey(conversationId, v)) }; };
    let h = await have();
    if (!h?.key) {
      const err = await refresh(conversationId);
      h = await have();
      if (!h?.key) throw new KeyUnavailableError(conversationId, version, await ask(conversationId, version), err);
    }
    return { key: h.key, version: h.v };
  }

  async function createSecureConversation(input: { participantIds: string[]; type?: 'direct' | 'group'; title?: string; metadata?: Record<string, unknown> }): Promise<E2eeConversation> {
    const participantIds = [...new Set([userId, ...input.participantIds])];
    const type = input.type ?? (participantIds.length === 2 ? 'direct' : 'group');
    for (let attempt = 1; ; attempt++) {
      const me = await device.requireDevice();
      const devices = await listDevices(client, participantIds);
      const missing = participantIds.filter((u) => !devices.some((d) => d.userId === u));
      if (missing.length) throw new ParticipantHasNoDeviceError('Some participants have no registered device', { status: 409, code: 'PARTICIPANT_HAS_NO_DEVICE', details: { userIds: missing } });
      const id = uuidv4(provider), ck = newConversationKey(provider);
      const keys = wrapKeyForDevices({ conversationKey: ck, conversationId: id, keyVersion: 1, sender: { deviceId: me.deviceId, privateKey: me.privateKey }, recipients: devices.map((d) => ({ deviceId: d.id, publicKey: d.publicKey })), provider });
      try {
        const conv = await device.withDevice((d) => createEncryptedConversation(client, d.deviceId, { id, type, title: input.title, metadata: input.metadata, participantIds, keys }));
        if (conv.id !== id) throw new ConversationIdNotSupportedError();
        await keyStore.set(keyNames.conversationKey(id, 1), ck);
        return conv;
      } catch (e) {
        if (e instanceof StaleDeviceSetError && attempt < MAX_CREATE_ATTEMPTS) continue; // a device was added or removed meanwhile: look again
        throw e;
      }
    }
  }

  async function sendSecureMessage(input: { conversationId: string; text: string; attachments?: AttachmentInput[]; type?: string; parentId?: string }) {
    const { conversationId } = input;
    // Attachments are encrypted and uploaded once, whatever happens to the key version later.
    const descriptors: AttachmentDescriptor[] = [];
    const serverAttachments: Array<{ type: 'file'; url: string; filename: string; mimeType: string; sizeBytes: number }> = [];
    for (const a of input.attachments ?? []) {
      const bytes = a.data instanceof Uint8Array ? a.data : new Uint8Array(await a.data.arrayBuffer());
      const { ciphertext, descriptor } = await encryptAttachment(bytes, { name: a.name, type: a.type, w: a.w, h: a.h }, { provider });
      const up = await uploader(new Blob([ciphertext as BlobPart], { type: 'application/octet-stream' }));
      descriptors.push(descriptor);
      serverAttachments.push({ type: 'file', url: up.url, filename: 'encrypted.bin', mimeType: 'application/octet-stream', sizeBytes: ciphertext.length });
    }
    if (beforeSend) { try { await beforeSend(conversationId); } catch { /* the check is best effort: never block a send on it */ } }
    let { key, version } = await keyFor(conversationId, null);
    for (let attempt = 1; ; attempt++) {
      const content = encryptSecureMessage({ text: input.text, attachments: descriptors }, key, { conversationId, keyVersion: version, senderId: userId }, { provider });
      try {
        return await device.withDevice(() => postEncryptedMessage(client, { conversationId, senderId: userId, content, keyVersion: version, type: input.type, parentId: input.parentId, attachments: serverAttachments.length ? serverAttachments : undefined }));
      } catch (e) {
        // The server refused BEFORE storing anything, so re-encrypting under a newer key cannot duplicate the message.
        if (e instanceof KeyRotationRequiredError && attempt < 2) {
          await refresh(conversationId);
          const newest = (await versionsOf(conversationId)).pop();
          if (newest !== undefined && newest >= e.minKeyVersion && newest !== version) { ({ key, version } = await keyFor(conversationId, newest)); continue; }
          throw new KeyUnavailableError(conversationId, e.minKeyVersion, await ask(conversationId, e.minKeyVersion), e);
        }
        throw e;
      }
    }
  }

  async function decryptMessage(m: ServerMessage): Promise<DecryptedMessage> {
    const md = m.metadata ?? {};
    if (md.scheme !== 'ck-xchacha-v1' || typeof md.key_version !== 'number' || !Number.isInteger(md.key_version) || md.key_version < 1) throw new FormatError('BAD_INPUT', 'not an end-to-end encrypted message (metadata.scheme / key_version)');
    if (typeof m.content !== 'string') throw new FormatError('BAD_INPUT', 'message has no content');
    const { key } = await keyFor(m.conversation_id, md.key_version);
    const out = decryptSecureMessage(m.content, key, { conversationId: m.conversation_id, keyVersion: md.key_version, senderId: m.sender_id }, { provider });
    const urls = m.attachments ?? [];
    // Descriptors (encrypted) and stored objects (server-visible) pair by position. A server that drops, adds or reorders them is caught here or by the AEAD on open.
    if (urls.length !== out.attachments.length) throw new FormatError('BAD_PAYLOAD', 'attachment count does not match the encrypted message');
    return { id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, text: out.text, attachments: out.attachments.map((descriptor, i) => ({ descriptor, url: urls[i].url })), createdAt: m.created_at, keyVersion: md.key_version };
  }
  async function decryptMessages(list: ServerMessage[]): Promise<DecryptOutcome[]> {
    const out: DecryptOutcome[] = [];
    for (const m of list) { try { out.push({ ok: true, message: await decryptMessage(m) }); } catch (error) { out.push({ ok: false, id: m.id, error }); } }
    return out;
  }
  async function openAttachment(a: DecryptedAttachment): Promise<{ bytes: Uint8Array; name: string; type: string }> {
    const bytes = await decryptAttachment(await download(a.url), a.descriptor, { provider });
    return { bytes, name: a.descriptor.name, type: a.descriptor.type };
  }

  return {
    createSecureConversation, sendSecureMessage, decryptMessage, decryptMessages, openAttachment, refreshKeys: refresh,
    /** Used by the re-keying engine: runs before every send (the piggyback check). */
    setBeforeSend(fn: ((conversationId: string) => Promise<void>) | null) { beforeSend = fn; },
    /** Key versions held on this device for a conversation, ascending. */
    heldVersions: versionsOf,
  };
}
export type SecureMessaging = ReturnType<typeof createSecureMessaging>;
