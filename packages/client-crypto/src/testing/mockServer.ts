// A contract-faithful, in-memory stand-in for the Stage 7 server (docs/E2EE_API_CONTRACT.md), exposed as a `fetch`.
// Use it with the real core client:  createClient({ baseUrl: 'http://mock', token: mock.tokenFor(userId), fetch: mock.fetch })
// It enforces the rules that matter: one primary, single-use pairing approvals, atomic create-with-keys, exact device sets,
// first-writer-wins keys, min_key_version, [Dev] header checks, flag-off 404s. It is a test double, not a server: no persistence, no real auth.

export interface MockEvent { event: string; to: string[]; data: Record<string, unknown> }
export interface MockOptions {
  /** false = every E2EE route answers 404 NOT_FOUND, like E2EE_ENABLED=off. Default true. */
  e2eeEnabled?: boolean;
  maxDevicesPerUser?: number; // default 5
  pairingTtlSeconds?: number; // default 60
  keysMaxBatch?: number; // default 200
  now?: () => number; // ms; inject to expire pairings without waiting
}
export interface Injection { match: RegExp | string; status: number; code: string; message?: string; retryAfter?: number; times?: number }

export interface Device { id: string; userId: string; publicKey: string; deviceName: string | null; isPrimary: boolean; createdAt: string; revokedAt: string | null }
export interface Pairing { userId: string; publicKey: string; expiresAt: number }
export interface Conv { id: string; type: string; title: string | null; encryption_mode: 'none' | 'e2ee-v1'; min_key_version: number; participants: string[]; metadata: Record<string, unknown>; created_at: string }
export interface KeyRowS { conversationId: string; deviceId: string; keyVersion: number; wrappedKey: string; wrappedByDeviceId: string }
interface Principal { kind: 'user' | 'admin' | 'api'; userId?: string }

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
const E = {
  validation: (m: string) => new HttpError(400, 'VALIDATION_ERROR', m),
  forbidden: (m: string) => new HttpError(403, 'FORBIDDEN', m),
  notFound: (m = 'Resource not found') => new HttpError(404, 'NOT_FOUND', m),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64 = /^[A-Za-z0-9_-]+$/;
const b64Len = (s: unknown) => (typeof s === 'string' && B64.test(s) ? Math.floor((s.length * 3) / 4) : -1);
const uuid = (): string => globalThis.crypto.randomUUID();
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function pubKey(v: unknown, field = 'publicKey'): string {
  if (typeof v !== 'string' || v.length !== 43 || !B64.test(v)) throw E.validation(`${field} must be 32 bytes, base64url encoded`);
  return v;
}

export function createMockServer(options: MockOptions = {}) {
  const cfg = {
    e2eeEnabled: options.e2eeEnabled ?? true,
    maxDevices: options.maxDevicesPerUser ?? 5,
    ttl: options.pairingTtlSeconds ?? 60,
    maxBatch: options.keysMaxBatch ?? 200,
    now: options.now ?? (() => Date.now()),
  };
  const users = new Set<string>();
  const devices = new Map<string, Device>();
  const pairings = new Map<string, Pairing>(); // by userId: one live approval per user
  const convs = new Map<string, Conv>();
  const keys: KeyRowS[] = [];
  const messages: Record<string, unknown>[] = [];
  const backups = new Map<string, { blob: string; kdf: unknown; updatedAt: string }>();
  const events: MockEvent[] = [];
  const injections: Injection[] = [];
  const calls: { method: string; path: string; deviceId: string | null }[] = [];
  const iso = () => new Date(cfg.now()).toISOString();

  const emit = (event: string, to: Iterable<string>, data: Record<string, unknown>) => events.push({ event, to: [...new Set(to)], data });
  const active = (userId: string) => [...devices.values()].filter((d) => d.userId === userId && !d.revokedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const deviceView = (d: Device) => ({ id: d.id, userId: d.userId, publicKey: d.publicKey, isPrimary: d.isPrimary, deviceName: d.deviceName });
  const e2eeConvIdsOf = (userId: string) => [...convs.values()].filter((c) => c.encryption_mode === 'e2ee-v1' && c.participants.includes(userId)).map((c) => c.id);
  const coMembers = (userId: string) => {
    const s = new Set<string>([userId]);
    for (const c of convs.values()) if (c.encryption_mode === 'e2ee-v1' && c.participants.includes(userId)) c.participants.forEach((p) => s.add(p));
    return s;
  };

  function auth(req: Request): Principal {
    const h = req.headers.get('authorization') ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (token === 'admin') return { kind: 'admin' };
    if (token === 'api') return { kind: 'api' };
    if (token.startsWith('user:') && token.length > 5) return { kind: 'user', userId: token.slice(5) };
    throw new HttpError(401, 'UNAUTHORIZED', 'Invalid or missing token');
  }
  const needUser = (p: Principal): string => {
    if (p.kind !== 'user' || !p.userId) throw E.forbidden('This endpoint needs a token issued for a specific user');
    return p.userId;
  };
  /** [Dev] check: header present, an active device of the token's user. */
  function needDevice(req: Request, userId: string): Device {
    const id = req.headers.get('x-device-id');
    if (!id) throw new HttpError(403, 'DEVICE_REQUIRED', 'This endpoint needs an X-Device-Id header');
    const d = devices.get(id);
    if (!d || d.revokedAt || d.userId !== userId) throw new HttpError(403, 'DEVICE_INVALID', 'X-Device-Id is not an active device of this user');
    return d;
  }
  const getConv = (id: string): Conv => {
    const c = UUID.test(id) ? convs.get(id) : undefined;
    if (!c) throw E.notFound('Conversation not found');
    return c;
  };
  function memberE2ee(id: string, userId: string): Conv {
    const c = getConv(id);
    if (!c.participants.includes(userId)) throw E.forbidden('You are not a participant of this conversation');
    if (c.encryption_mode !== 'e2ee-v1') throw E.validation('This conversation is not end-to-end encrypted');
    return c;
  }
  const latestVersion = (convId: string) => keys.filter((k) => k.conversationId === convId).reduce((m, k) => Math.max(m, k.keyVersion), 0);
  const convView = (c: Conv) => ({
    id: c.id, type: c.type, title: c.title, metadata: c.metadata, encryption_mode: c.encryption_mode, min_key_version: c.min_key_version,
    created_at: c.created_at, participants: c.participants.map((id) => ({ id, role: 'member' })),
  });

  function parseKeyEntries(v: unknown, callerDevice: Device): { deviceId: string; wrappedKey: string }[] {
    if (!Array.isArray(v) || v.length === 0) throw E.validation('keys must be a non-empty array');
    if (v.length > cfg.maxBatch) throw E.validation(`keys accepts at most ${cfg.maxBatch} entries`);
    const seen = new Set<string>();
    return v.map((raw) => {
      if (!isObj(raw)) throw E.validation('each key must be an object');
      const { deviceId, wrappedKey, wrappedByDeviceId } = raw;
      if (typeof deviceId !== 'string' || !UUID.test(deviceId)) throw E.validation('deviceId must be a UUID');
      if (typeof wrappedByDeviceId !== 'string' || !UUID.test(wrappedByDeviceId)) throw E.validation('wrappedByDeviceId must be a UUID');
      if (typeof wrappedKey !== 'string' || wrappedKey.length < 55 || wrappedKey.length > 683 || !B64.test(wrappedKey)) throw E.validation('wrappedKey must be base64url');
      if (seen.has(deviceId)) throw E.validation('keys contains the same deviceId more than once');
      seen.add(deviceId);
      if (wrappedByDeviceId !== callerDevice.id) throw E.validation('wrappedByDeviceId must be the calling device (X-Device-Id)');
      return { deviceId, wrappedKey };
    });
  }
  /** The exact-cover rule shared by create and rotation. Throws PARTICIPANT_HAS_NO_DEVICE first, then STALE_DEVICE_SET. */
  function requireExactCover(participants: string[], deviceIds: string[]) {
    const missing = participants.filter((u) => active(u).length === 0);
    if (missing.length) throw new HttpError(409, 'PARTICIPANT_HAS_NO_DEVICE', 'Some participants have no registered device', { userIds: missing });
    const required = participants.flatMap((u) => active(u).map((d) => d.id));
    const got = new Set(deviceIds);
    if (required.length !== got.size || required.some((id) => !got.has(id))) {
      throw new HttpError(409, 'STALE_DEVICE_SET', 'The device set changed. Wrap the key for exactly these devices and retry.', { deviceIds: required });
    }
  }

  type Ctx = { req: Request; url: URL; p: Principal; body: unknown; m: RegExpMatchArray };
  type Handler = (c: Ctx) => { status: number; data: unknown } | Promise<{ status: number; data: unknown }>;
  const routes: { method: string; re: RegExp; e2ee: boolean; h: Handler }[] = [];
  const route = (method: string, re: RegExp, e2ee: boolean, h: Handler) => routes.push({ method, re, e2ee, h });
  const ok = (data: unknown, status = 200) => ({ status, data });

  route('POST', /^\/devices$/, true, ({ req, p, body }) => {
    const userId = needUser(p);
    if (!isObj(body)) throw E.validation('Invalid body');
    const publicKey = pubKey(body.publicKey);
    const name = body.deviceName;
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 64)) throw E.validation('deviceName must be 1-64 characters');
    if (!users.has(userId)) throw E.notFound('User not found');
    if (active(userId).length) throw new HttpError(409, 'DEVICE_EXISTS', 'This user already has an active device. Link a new device from an existing one, or restore from a backup.');
    const d: Device = { id: uuid(), userId, publicKey, deviceName: typeof name === 'string' ? name.trim() : null, isPrimary: true, createdAt: iso(), revokedAt: null };
    devices.set(d.id, d);
    void req;
    return ok({ id: d.id, isPrimary: true, createdAt: d.createdAt }, 201);
  });

  route('GET', /^\/devices$/, true, ({ p, url }) => {
    needUser(p);
    const raw = url.searchParams.get('userIds');
    const ids = [...new Set((raw ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
    if (!ids.length) throw E.validation('userIds must contain at least one id');
    if (ids.length > 50) throw E.validation('userIds accepts at most 50 ids');
    if (ids.some((i) => !UUID.test(i))) throw E.validation('userIds must be UUIDs');
    return ok(ids.flatMap((u) => active(u)).map(deviceView));
  });

  // Backup routes are declared before /devices/:id so "backup" is never taken for an id.
  route('PUT', /^\/devices\/backup$/, true, ({ p, body }) => {
    const userId = needUser(p);
    if (!isObj(body) || Object.keys(body).some((k) => k !== 'blob' && k !== 'kdf')) throw E.validation('Invalid body');
    const n = b64Len(body.blob);
    if (n < 1 || n > 8192) throw E.validation('blob must be base64url, at most 8192 bytes');
    const k = body.kdf;
    const intIn = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
    if (!isObj(k) || Object.keys(k).some((x) => !['v', 'alg', 'm', 't', 'p', 'salt'].includes(x)) || k.v !== 1 || k.alg !== 'argon2id' ||
        !intIn(k.m, 1024, 4194304) || !intIn(k.t, 1, 32) || !intIn(k.p, 1, 16) || b64Len(k.salt) < 16 || b64Len(k.salt) > 64) throw E.validation('Invalid kdf');
    const rec = { blob: body.blob as string, kdf: k, updatedAt: iso() };
    backups.set(userId, rec);
    return ok({ updatedAt: rec.updatedAt });
  });
  route('GET', /^\/devices\/backup$/, true, ({ p }) => {
    const r = backups.get(needUser(p));
    if (!r) throw E.notFound('No backup stored');
    return ok(r);
  });
  route('DELETE', /^\/devices\/backup$/, true, ({ p }) => { backups.delete(needUser(p)); return ok({ deleted: true }); });

  route('DELETE', /^\/devices\/([^/]+)$/, true, ({ p, m }) => {
    const userId = needUser(p);
    const d = UUID.test(m[1]) ? devices.get(m[1]) : undefined;
    if (!d || d.revokedAt || d.userId !== userId) throw E.notFound('Device not found');
    revoke(d);
    return ok({ id: d.id, revokedAt: d.revokedAt });
  });
  function revoke(d: Device) {
    d.revokedAt = iso();
    if (d.isPrimary) {
      d.isPrimary = false;
      const next = active(d.userId)[0];
      if (next) next.isPrimary = true;
    }
    emit('device.removed', coMembers(d.userId), { userId: d.userId, deviceId: d.id, conversationIds: e2eeConvIdsOf(d.userId) });
  }

  route('POST', /^\/devices\/pair$/, true, ({ req, p, body }) => {
    const userId = needUser(p);
    const caller = needDevice(req, userId);
    if (!caller.isPrimary) throw E.forbidden('Only the primary device can approve a new device');
    if (!isObj(body)) throw E.validation('Invalid body');
    const publicKey = pubKey(body.publicKey);
    if (active(userId).some((d) => d.publicKey === publicKey)) throw E.validation('That public key already belongs to an active device of this user');
    const expiresAt = cfg.now() + cfg.ttl * 1000;
    pairings.set(userId, { userId, publicKey, expiresAt }); // replaces any earlier approval: one live approval per user
    return ok({ expiresAt: new Date(expiresAt).toISOString() });
  });

  route('POST', /^\/devices\/link$/, true, ({ p, body }) => {
    const userId = needUser(p);
    if (!isObj(body)) throw E.validation('Invalid body');
    const publicKey = pubKey(body.publicKey);
    const name = body.deviceName;
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 64)) throw E.validation('deviceName must be 1-64 characters');
    if (!users.has(userId)) throw E.notFound('User not found');
    const pr = pairings.get(userId);
    if (!pr || pr.publicKey !== publicKey || pr.expiresAt <= cfg.now()) throw new HttpError(404, 'PAIRING_NOT_FOUND', 'No approved pairing for this public key (it may not be approved yet, or it expired)');
    const others = active(userId);
    if (others.length >= cfg.maxDevices) throw new HttpError(409, 'DEVICE_LIMIT', `This user already has the maximum of ${cfg.maxDevices} devices. Revoke one first.`);
    pairings.delete(userId); // single use
    const d: Device = { id: uuid(), userId, publicKey, deviceName: typeof name === 'string' ? name.trim() : null, isPrimary: false, createdAt: iso(), revokedAt: null };
    devices.set(d.id, d);
    const conversationIds = e2eeConvIdsOf(userId);
    emit('device.added', coMembers(userId), { userId, deviceId: d.id, publicKey, conversationIds });
    return ok({ id: d.id, isPrimary: false, devices: others.map(deviceView), conversationIds }, 201);
  });

  route('POST', /^\/users\/([^/]+)\/devices\/reset$/, true, ({ p, m }) => {
    if (p.kind !== 'admin' && p.kind !== 'api') throw E.forbidden('This endpoint needs an admin or api token');
    const target = decodeURIComponent(m[1]);
    const list = active(target);
    pairings.delete(target);
    list.forEach(revoke);
    return ok({ revoked: list.length });
  });

  route('POST', /^\/conversations$/, false, ({ req, p, body }) => {
    if (!isObj(body)) throw E.validation('Invalid body');
    const mode = body.encryptionMode ?? 'none';
    if (mode !== 'none' && mode !== 'e2ee-v1') throw E.validation('encryptionMode must be "none" or "e2ee-v1"');
    if (mode === 'e2ee-v1' && !cfg.e2eeEnabled) throw E.validation('encryptionMode "e2ee-v1" is not enabled on this server');
    const type = body.type;
    if (type !== 'direct' && type !== 'group') throw E.validation('type must be "direct" or "group"');
    const ids = body.participantIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== 'string') || new Set(ids).size !== ids.length) throw E.validation('participantIds must be a non-empty list of unique ids');
    if ((ids as string[]).some((u) => !users.has(u))) throw E.validation('Some participants are not users of this project');
    let cid = uuid();
    if (body.id !== undefined) {
      // PROPOSED contract change (Lane A 7.10): a client-chosen id, because wraps are bound to the conversation id and must exist before it does.
      if (typeof body.id !== 'string' || !UUID.test(body.id)) throw E.validation('id must be a UUID');
      if (convs.has(body.id)) throw new HttpError(409, 'CONVERSATION_EXISTS', 'A conversation with this id already exists');
      cid = body.id;
    }
    const conv: Conv = { id: cid, type, title: typeof body.title === 'string' ? body.title : null, encryption_mode: mode, min_key_version: 1, participants: ids as string[], metadata: isObj(body.metadata) ? body.metadata : {}, created_at: iso() };
    if (mode === 'none') {
      if (body.keys !== undefined) throw E.validation('keys is only valid with encryptionMode "e2ee-v1"');
      convs.set(conv.id, conv);
      return ok(convView(conv), 201);
    }
    const userId = needUser(p);
    const caller = needDevice(req, userId);
    if (!conv.participants.includes(userId)) throw E.validation('The creator must be one of participantIds');
    const entries = parseKeyEntries(body.keys, caller);
    requireExactCover(conv.participants, entries.map((e) => e.deviceId));
    // Atomic: nothing is written until every check above passed.
    convs.set(conv.id, conv);
    for (const e of entries) keys.push({ conversationId: conv.id, deviceId: e.deviceId, keyVersion: 1, wrappedKey: e.wrappedKey, wrappedByDeviceId: caller.id });
    emit('keys.updated', entries.map((e) => devices.get(e.deviceId)!.userId), { conversationId: conv.id, keyVersion: 1, deviceIds: entries.map((e) => e.deviceId) });
    return ok(convView(conv), 201);
  });

  route('GET', /^\/conversations\/([^/]+)\/keys$/, true, ({ req, p, m }) => {
    const userId = needUser(p);
    const dev = needDevice(req, userId);
    const c = memberE2ee(m[1], userId);
    return ok(keys.filter((k) => k.conversationId === c.id && k.deviceId === dev.id).sort((a, b) => a.keyVersion - b.keyVersion).map((k) => ({
      keyVersion: k.keyVersion, wrappedKey: k.wrappedKey, wrappedByDeviceId: k.wrappedByDeviceId, wrappedByPublicKey: devices.get(k.wrappedByDeviceId)!.publicKey,
    })));
  });

  route('POST', /^\/conversations\/([^/]+)\/keys$/, true, ({ req, p, m, body }) => {
    const userId = needUser(p);
    const caller = needDevice(req, userId);
    const c = memberE2ee(m[1], userId);
    if (!isObj(body) || typeof body.keyVersion !== 'number' || !Number.isInteger(body.keyVersion) || body.keyVersion < 1) throw E.validation('keyVersion must be an integer >= 1');
    const entries = parseKeyEntries(body.keys, caller);
    const latest = latestVersion(c.id);
    const version = body.keyVersion;
    if (version > latest + 1) throw E.validation(`keyVersion must be at most ${latest + 1} (the latest version is ${latest})`);
    if (version === latest + 1) {
      requireExactCover(c.participants, entries.map((e) => e.deviceId));
    } else {
      const allowed = new Set(c.participants.flatMap((u) => active(u).map((d) => d.id)));
      if (entries.some((e) => !allowed.has(e.deviceId))) throw E.validation('Some target devices are not active devices of current participants');
    }
    const fresh = entries.filter((e) => !keys.some((k) => k.conversationId === c.id && k.deviceId === e.deviceId && k.keyVersion === version));
    if (!fresh.length) throw new HttpError(409, 'KEY_EXISTS', 'A key for these devices and this key version already exists');
    for (const e of fresh) keys.push({ conversationId: c.id, deviceId: e.deviceId, keyVersion: version, wrappedKey: e.wrappedKey, wrappedByDeviceId: caller.id });
    emit('keys.updated', fresh.map((e) => devices.get(e.deviceId)!.userId), { conversationId: c.id, keyVersion: version, deviceIds: fresh.map((e) => e.deviceId) });
    return ok({ inserted: fresh.length }, 201);
  });

  route('POST', /^\/conversations\/([^/]+)\/keys\/request$/, true, ({ req, p, m, body }) => {
    const userId = needUser(p);
    const dev = needDevice(req, userId);
    const c = memberE2ee(m[1], userId);
    const v = isObj(body) ? body.keyVersion : undefined;
    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) throw E.validation('keyVersion must be an integer >= 1');
    emit('keys.requested', c.participants.filter((u) => u !== userId), { conversationId: c.id, ...(v !== undefined ? { keyVersion: v } : {}), requestingDeviceId: dev.id });
    return ok({ requested: true }, 202);
  });

  route('POST', /^\/conversations\/([^/]+)\/participants$/, false, ({ p, m, body }) => {
    const c = getConv(m[1]);
    if (p.kind === 'user' && !c.participants.includes(p.userId!)) throw E.forbidden('You are not a participant of this conversation');
    if (!isObj(body) || typeof body.userId !== 'string') throw E.validation('userId is required');
    if (!users.has(body.userId)) throw E.validation('User not found in this project');
    if (c.participants.includes(body.userId)) return ok({ conversationId: c.id, userId: body.userId }, 200);
    if (c.encryption_mode === 'e2ee-v1' && active(body.userId).length === 0) throw new HttpError(409, 'PARTICIPANT_HAS_NO_DEVICE', 'Some participants have no registered device', { userIds: [body.userId] });
    c.participants.push(body.userId);
    if (c.encryption_mode === 'e2ee-v1') emit('participant.added', c.participants, { conversationId: c.id, userId: body.userId });
    return ok({ conversationId: c.id, userId: body.userId }, 201);
  });

  route('DELETE', /^\/conversations\/([^/]+)\/participants\/([^/]+)$/, false, ({ p, m }) => {
    const c = getConv(m[1]);
    const target = decodeURIComponent(m[2]);
    if (p.kind === 'user' && !c.participants.includes(p.userId!)) throw E.forbidden('You are not a participant of this conversation');
    const at = c.participants.indexOf(target);
    if (at < 0) throw E.notFound('Participant not found');
    const before = [...c.participants];
    c.participants.splice(at, 1);
    let min: number | null = null;
    if (c.encryption_mode === 'e2ee-v1') {
      c.min_key_version = Math.max(c.min_key_version, latestVersion(c.id) + 1);
      min = c.min_key_version;
      emit('participant.removed', before, { conversationId: c.id, userId: target, minKeyVersion: min });
    }
    return ok({ conversationId: c.id, userId: target, minKeyVersion: min });
  });

  route('POST', /^\/messages$/, false, ({ p, body }) => {
    if (!isObj(body)) throw E.validation('Invalid body');
    const c = typeof body.conversationId === 'string' ? convs.get(body.conversationId) : undefined;
    if (!c) throw E.notFound('Conversation not found');
    if (typeof body.senderId !== 'string' || !c.participants.includes(body.senderId)) throw E.validation('Sender is not a participant of this conversation');
    const md = isObj(body.metadata) ? body.metadata : {};
    if (c.encryption_mode === 'none') {
      if (md.scheme !== undefined) throw E.validation('metadata.scheme is only valid in an end-to-end encrypted conversation');
    } else if (cfg.e2eeEnabled) {
      const HINT = 'Use client.crypto.sendSecureMessage.';
      if (md.scheme !== 'ck-xchacha-v1') throw E.validation(`This conversation is end-to-end encrypted: metadata.scheme must be "ck-xchacha-v1". ${HINT}`);
      const kv = md.key_version;
      if (typeof kv !== 'number' || !Number.isInteger(kv) || kv < 1) throw E.validation(`metadata.key_version must be a positive integer. ${HINT}`);
      const raw = body.content;
      const n = b64Len(raw);
      if (typeof raw !== 'string' || n < 0) throw E.validation(`content must be a base64url ciphertext, not plaintext. ${HINT}`);
      if (n < 41 || (raw as string)[0] !== 'A') throw E.validation(`content is not a valid ck-xchacha-v1 ciphertext (wrong version byte or too short). ${HINT}`);
      const latest = latestVersion(c.id);
      if (latest === 0) throw new HttpError(409, 'KEYS_NOT_READY', 'No conversation keys have been uploaded yet for this conversation');
      if (kv < c.min_key_version) throw new HttpError(409, 'KEY_ROTATION_REQUIRED', `This conversation requires key version ${c.min_key_version} or newer. Fetch the latest key (or rotate) and retry.`, { minKeyVersion: c.min_key_version });
      if (kv > latest) throw E.validation(`key_version must be at most ${latest}`);
      for (const a of Array.isArray(body.attachments) ? body.attachments : []) {
        if (!isObj(a)) continue;
        if ((a.mimeType !== undefined && a.mimeType !== 'application/octet-stream') || a.thumbnailUrl || a.width || a.height || a.durationSeconds) throw E.validation('Attachments on an end-to-end encrypted message must be opaque blobs');
      }
    }
    void p;
    const msg = { id: uuid(), conversation_id: c.id, sender_id: body.senderId, content: body.content ?? null, type: body.type ?? 'text', metadata: md, created_at: iso(), attachments: body.attachments ?? [] };
    messages.push(msg);
    return ok(msg, 201);
  });

  route('GET', /^\/messages$/, false, ({ p, url }) => {
    const id = url.searchParams.get('conversationId');
    const c = id ? convs.get(id) : undefined;
    if (!c) throw E.notFound('Conversation not found');
    if (p.kind === 'user' && !c.participants.includes(p.userId!)) throw E.forbidden('You are not a participant of this conversation');
    const rows = messages.filter((m) => m.conversation_id === c.id).slice().reverse().map((m) => ({ ...m, sender: { id: m.sender_id } }));
    return { status: 200, data: rows };
  });

  async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    calls.push({ method: req.method, path, deviceId: req.headers.get('x-device-id') });
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    const fail = (e: HttpError, headers?: Record<string, string>) => reply(e.status, { error: { message: e.message, code: e.code, ...(e.details !== undefined ? { details: e.details } : {}) } }, headers);
    try {
      if (!url.pathname.startsWith('/api/v1/')) return fail(E.notFound());
      const principal = auth(req);
      const inj = injections.find((i) => (typeof i.match === 'string' ? `${req.method} ${path}`.includes(i.match) : i.match.test(`${req.method} ${path}`)));
      if (inj) {
        if (inj.times !== undefined && --inj.times <= 0) injections.splice(injections.indexOf(inj), 1);
        return fail(new HttpError(inj.status, inj.code, inj.message ?? inj.code), inj.retryAfter !== undefined ? { 'retry-after': String(inj.retryAfter) } : undefined);
      }
      let body: unknown;
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        const text = await req.text();
        if (text) { try { body = JSON.parse(text); } catch { throw E.validation('Body is not valid JSON'); } }
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = path.match(r.re);
        if (!m) continue;
        if (r.e2ee && !cfg.e2eeEnabled) throw E.notFound();
        const out = await r.h({ req, url, p: principal, body, m });
        return reply(out.status, { data: out.data });
      }
      return fail(E.notFound());
    } catch (e) {
      if (e instanceof HttpError) return fail(e);
      throw e;
    }
  }

  return {
    fetch: mockFetch as typeof fetch,
    /** Bearer tokens this mock understands: `user:<id>`, `admin`, `api`. */
    tokenFor: (userId: string) => `user:${userId}`,
    adminToken: 'admin',
    apiToken: 'api',
    /** Create a user (the real server's POST /users is the core client's job; this just makes the id known). Returns the id. */
    addUser: (id: string = uuid()) => { users.add(id); return id; },
    /** Make the next matching request(s) fail with this error, before any route runs (rate limits, outages). */
    inject: (i: Injection) => { injections.push({ ...i }); },
    setE2eeEnabled: (on: boolean) => { cfg.e2eeEnabled = on; },
    events,
    eventsOf: (name: string) => events.filter((e) => e.event === name),
    calls,
    /** Read-only views for assertions. */
    state: {
      devices: () => [...devices.values()],
      conversation: (id: string) => convs.get(id),
      keys: () => [...keys],
      messages: () => [...messages],
      pairings: () => [...pairings.values()],
    },
  };
}

export type MockServer = ReturnType<typeof createMockServer>;
