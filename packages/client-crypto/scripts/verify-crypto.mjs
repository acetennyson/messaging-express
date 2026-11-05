// End-to-end check of @messaging-express/client-crypto against a REAL running server (E2EE_ENABLED=on). Plain Node, no browser.
// DEV / STAGING ONLY: it creates users, conversations, messages and uploads.
//
//   1) build both packages once:   npm run build -w @messaging-express/client && npm run build -w @messaging-express/client-crypto
//   2) start the server:           npm run dev:socket        (with E2EE_ENABLED=on in .env.local)
//   3) run:                        node packages/client-crypto/scripts/verify-crypto.mjs
//
// The project (default: the smoke fixtures) must exist:  psql "$DATABASE_URL" -f scripts/smoke-seed.sql
// Reads JWT_SECRET (and BASE_URL, default http://localhost:3000) from the environment or .env.local. Options: PROJECT_ID, ORG_ID.
// Three parts: (1) the whole lifecycle with real clients, (2) a malicious server (tampered answers) must not fool the clients,
// (3) the in-memory mock server and the real server must answer the same scenarios the same way (stops the mock drifting).
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const name of ['.env.local', '.env']) {
  const file = path.resolve(here, '..', '..', '..', name);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const SECRET = process.env.JWT_SECRET;
const PROJECT = process.env.PROJECT_ID || '00000000-0000-4000-8000-0000000000a2';
const ORG = process.env.ORG_ID || '00000000-0000-4000-8000-0000000000a1';
if (!SECRET) { console.error('Set JWT_SECRET (or put it in .env.local): the script signs its own test tokens.'); process.exit(2); }

let core, X, testing;
try {
  core = await import('@messaging-express/client');
  X = await import('../dist/index.js');
  testing = await import('../dist/testing/index.js');
} catch (e) {
  console.error(`Could not load the built packages (${e.code || e.message}).\nBuild them first:\n  npm run build -w @messaging-express/client\n  npm run build -w @messaging-express/client-crypto`);
  process.exit(2);
}

const stale = ['listConversationDevices', 'createRekeyEngine', 'createBackupManager', 'createSafetyManager', 'createSecureMessaging'].filter((n) => typeof X[n] !== 'function');
if (stale.length) {
  console.error(`packages/client-crypto/dist is older than this script (missing: ${stale.join(', ')}).\nRebuild it, then run again:\n  npm run build -w @messaging-express/client-crypto   (and, if you have not yet: npm run build -w @messaging-express/client)`);
  process.exit(2);
}

let failed = 0;
const say = (s = '') => console.log(s);
const check = (cond, label, hint) => { say(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) { failed++; if (hint) say(`        -> ${hint}`); } return !!cond; };
const settle = async (label, fn) => { try { return await fn(); } catch (e) { failed++; say(`  FAIL  ${label}: ${e?.name || 'Error'}: ${e?.message || e}`); return undefined; } };
const fail = (p) => p.then(() => null, (e) => e);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mint = (userId) => {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ projectId: PROJECT, organizationId: ORG, type: userId ? 'user' : 'api', ...(userId ? { userId } : {}), iat: now, exp: now + 3600 })}`;
  return `${data}.${createHmac('sha256', SECRET).update(data).digest('base64url')}`;
};
const FAST = { params: { m: 1024, t: 1, p: 1 } }; // cheap Argon2id; the shipped default is 64 MiB x 3

/** One client+key store for a user. `fetch` can be a tampering wrapper. */
function actor(userId, o = {}) {
  const store = X.memoryKeyStore();
  const client = X.withCrypto(core.createClient({ baseUrl: BASE, token: () => mint(userId), maxRetries: 0, ...(o.fetch ? { fetch: o.fetch } : {}) }),
    { keyStore: store, userId, jitterMs: 0, backup: FAST, deviceTrust: o.deviceTrust, ...(o.download ? { download: o.download } : {}) });
  const c = client.crypto;
  return { id: userId, store, client, dev: c.device, sec: c.secure, rekey: c.rekey, safety: c.safety, backup: c.backup, api: c };
}
const api = core.createClient({ baseUrl: BASE, token: () => mint(), maxRetries: 0 });
const stamp = Date.now();
const newUser = async (name) => (await api.users.upsert({ externalId: `verify-crypto-${name}-${stamp}`, name: `verify ${name}` })).id;
const texts = async (u, conv) => (await u.sec.decryptMessages((await u.client.messages.list({ conversationId: conv })).data)).map((o) => (o.ok ? o.message.text : `ERR:${o.error?.name}`));
const bytes = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255);

// ============================================================ 1. lifecycle
async function lifecycle() {
  say('1. Lifecycle with real clients');
  const alice = actor(await newUser('alice')), bob = actor(await newUser('bob')), carol = actor(await newUser('carol'));
  for (const u of [alice, bob, carol]) await u.dev.registerPrimaryDevice({ deviceName: 'phone' });
  check((await Promise.all([alice, bob, carol].map((u) => u.dev.currentDevice()))).every((d) => d && d.role === 'primary'), 'three users with one primary device each');

  const conv = await settle('create conversation', () => alice.sec.createSecureConversation({ participantIds: [bob.id, carol.id], type: 'group' }));
  if (!conv) return;
  check(conv.encryption_mode === 'e2ee-v1' && conv.min_key_version === 1, 'encrypted group conversation created with one key per device, atomically');

  await alice.sec.sendSecureMessage({ conversationId: conv.id, text: 'hello from alice' });
  check((await texts(bob, conv.id)).includes('hello from alice') && (await texts(carol, conv.id)).includes('hello from alice'), 'bob and carol read it');
  const raw = (await alice.client.messages.list({ conversationId: conv.id })).data[0];
  check(!String(raw.content).includes('hello from alice') && raw.metadata?.scheme === 'ck-xchacha-v1', 'the server stores only ciphertext');

  const file = bytes(200_000);
  await settle('attachment', async () => {
    await alice.sec.sendSecureMessage({ conversationId: conv.id, text: 'a file', attachments: [{ data: file, name: 'secret-plan.bin', type: 'application/octet-stream' }] });
    const [m] = (await bob.sec.decryptMessages((await bob.client.messages.list({ conversationId: conv.id })).data)).filter((o) => o.ok && o.message.text === 'a file').map((o) => o.message);
    const opened = await bob.sec.openAttachment(m.attachments[0]);
    check(opened.name === 'secret-plan.bin' && Buffer.compare(Buffer.from(opened.bytes), Buffer.from(file)) === 0, 'encrypted attachment uploaded and opened byte for byte (real upload route)');
    check(!String(m.attachments[0].url).includes('secret-plan'), 'the stored file has no readable name');
  });

  await settle('third device', async () => {
    const laptop = actor(bob.id);
    const offer = await laptop.dev.beginLink();
    await (await bob.dev.approveLink(offer.qrPayload)).confirm();
    await laptop.dev.completeLink({ deviceName: 'laptop', pollIntervalMs: 300 });
    const before = await texts(laptop, conv.id);
    check(before.every((t) => t.startsWith('ERR:')), 'a newly linked device cannot read yet');
    await alice.rekey.checkBeforeSend(conv.id, true); // the pre-send check: seals the key for the laptop
    await laptop.sec.refreshKeys(conv.id);
    const after = await texts(laptop, conv.id);
    check(after.includes('hello from alice'), 'after the next send-time check the laptop reads the whole history');
    const nA = await alice.safety.forUser(bob.id), nB = await bob.safety.forUser(alice.id);
    check(nA.text === nB.text, 'alice and bob compute the same safety number');
  });

  await settle('remove a member and rotate', async () => {
    const removed = await alice.client.crypto.conversations.removeParticipant(conv.id, carol.id);
    check(removed.minKeyVersion === 2, 'removing carol raised min_key_version to 2');
    const ck1 = await alice.store.get(X.keyNames.conversationKey(conv.id, 1));
    const stale = X.encryptSecureMessage({ text: 'sent with the old key' }, ck1, { conversationId: conv.id, keyVersion: 1, senderId: alice.id });
    const old = await fail(X.postEncryptedMessage(alice.client, { conversationId: conv.id, senderId: alice.id, content: stale, keyVersion: 1 }));
    check(old instanceof X.KeyRotationRequiredError, 'the server refuses new messages under the old key');
    const r = await alice.rekey.rotate(conv.id, { minKeyVersion: 2 });
    check(r.version === 2, 'alice rotated to key version 2');
    await alice.sec.sendSecureMessage({ conversationId: conv.id, text: 'after the removal' });
    await bob.sec.refreshKeys(conv.id);
    check((await texts(bob, conv.id)).includes('after the removal'), 'bob (two devices) reads the new message');
    const k = await fail(carol.client.crypto.keys.get(conv.id, (await carol.dev.currentDevice()).deviceId));
    check(k instanceof X.ForbiddenError, 'carol can no longer fetch keys');
    check(!(await texts(carol, conv.id)).includes('after the removal'), 'carol cannot read the new message');
  });

  await settle('backup and restore', async () => {
    const code = alice.backup.generateRecoveryCode();
    await alice.backup.create(code);
    const phone2 = actor(alice.id);
    const r = await phone2.backup.restore(code);
    check(r.deviceId === (await alice.dev.currentDevice()).deviceId && r.conversations.withKeys >= 1, 'a fresh device restored the same identity and fetched its keys');
    check((await texts(phone2, conv.id)).includes('hello from alice'), 'the restored device reads the old history');
    const wrong = await fail(actor(alice.id).backup.restore(alice.backup.generateRecoveryCode()));
    check(wrong instanceof X.DecryptError, 'a wrong recovery code is rejected');
    await alice.client.crypto.backup.delete();
  });
  return { alice, bob, conv };
}

// ============================================================ 2. malicious server
/** A fetch that edits JSON answers while `edit` is set: edit(url, method, json) returns the replacement (or undefined to leave it). */
function tampering() {
  const t = { edit: null, fetch: async (input, init) => {
    const res = await fetch(input, init);
    if (!t.edit || !res.headers.get('content-type')?.includes('json')) return res;
    const url = new URL(typeof input === 'string' ? input : input.url ?? input.href), json = await res.clone().json();
    const out = t.edit(url.pathname.replace(/^\/api\/v1/, ''), (init?.method ?? 'GET').toUpperCase(), json);
    return out === undefined ? res : new Response(JSON.stringify(out), { status: res.status, headers: res.headers });
  } };
  return t;
}
async function malicious() {
  say('\n2. A malicious server must not fool the clients');
  const a = actor(await newUser('m-alice')), t = tampering(), b = actor(await newUser('m-bob'), { fetch: t.fetch });
  for (const u of [a, b]) await u.dev.registerPrimaryDevice({ deviceName: 'phone' });
  const c1 = await a.sec.createSecureConversation({ participantIds: [b.id] }), c2 = await a.sec.createSecureConversation({ participantIds: [b.id] });
  await a.sec.sendSecureMessage({ conversationId: c1.id, text: 'one' });
  await a.sec.sendSecureMessage({ conversationId: c1.id, text: 'two' });
  await a.sec.sendSecureMessage({ conversationId: c2.id, text: 'other conversation' });
  await a.sec.sendSecureMessage({ conversationId: c1.id, text: 'with file', attachments: [{ data: bytes(70_000), name: 'f.bin', type: 'application/octet-stream' }] });
  const list = async (c) => (await b.client.messages.list({ conversationId: c })).data;
  const names = async (ms) => (await b.sec.decryptMessages(ms)).map((o) => (o.ok ? o.message.text : `ERR:${o.error?.name}`));
  const other = (await list(c2.id))[0];

  t.edit = (p, m, j) => (p === '/messages' && m === 'GET' ? { ...j, data: j.data.map((x) => (x.conversation_id === c1.id ? { ...x, content: other.content, metadata: other.metadata } : x)) } : undefined);
  check((await names(await list(c1.id))).every((x) => x.startsWith('ERR:')), "ciphertext swapped in from another conversation is rejected");
  t.edit = (p, m, j) => (p === '/messages' && m === 'GET' ? { ...j, data: j.data.map((x) => ({ ...x, conversation_id: c2.id })) } : undefined);
  check((await names(await list(c1.id))).every((x) => x.startsWith('ERR:')), 'a message replayed into another conversation is rejected');
  t.edit = (p, m, j) => (p === '/messages' && m === 'GET' ? { ...j, data: j.data.map((x) => ({ ...x, sender_id: b.id })) } : undefined);
  check((await names(await list(c1.id))).every((x) => x.startsWith('ERR:')), 'a message re-attributed to another sender is rejected');
  t.edit = (p, m, j) => (p === '/messages' && m === 'GET' ? { ...j, data: j.data.map((x) => ({ ...x, attachments: [] })) } : undefined);
  {
    t.edit = null;
    const honest = await list(c1.id);
    const fileMsg = honest.find((m) => m.attachments?.length);
    const stripped = honest.map((m) => (m.id === fileMsg.id ? { ...m, attachments: [] } : m));
    const out = (await b.sec.decryptMessages(stripped)).find((x) => (x.ok ? x.message.id : x.id) === fileMsg.id);
    check(out && !out.ok, 'a message whose attachments were dropped by the server is rejected');
  }
  t.edit = null;
  const [x, y] = (await list(c1.id)).filter((m) => !m.attachments?.length);
  const swapped = [{ ...x, content: y.content, metadata: y.metadata }, { ...y, content: x.content, metadata: x.metadata }];
  check((await names(swapped)).every((s) => !s.startsWith('ERR:')), 'DOCUMENTED LIMIT: two messages swapped inside the same conversation still decrypt (the server can reorder, drop or repeat messages)');

  // keys: rows from another conversation, and an old version relabelled as newer
  const bobDev = (await b.dev.currentDevice()).deviceId;
  const rows2 = await b.client.crypto.keys.get(c2.id, bobDev);
  const bobFresh = actor(b.id, { fetch: t.fetch });
  await bobFresh.store.set(X.keyNames.device, await b.store.get(X.keyNames.device)); // same device identity, empty conversation-key cache
  t.edit = (p, m, j) => (p === `/conversations/${c1.id}/keys` && m === 'GET' ? { ...j, data: rows2 } : undefined);
  await bobFresh.sec.refreshKeys(c1.id).catch(() => undefined);
  const held = await bobFresh.sec.heldVersions(c1.id);
  check(held.length === 0, 'wrapped keys swapped in from another conversation are not accepted (nothing cached)');
  t.edit = (p, m, j) => (p === `/conversations/${c1.id}/keys` && m === 'GET' ? { ...j, data: j.data.map((r) => ({ ...r, keyVersion: r.keyVersion + 1 })) } : undefined);
  await bobFresh.sec.refreshKeys(c1.id).catch(() => undefined);
  check((await bobFresh.sec.heldVersions(c1.id)).length === 0, 'a key row relabelled with another version is not accepted');
  t.edit = null;

  // attachments: truncated and bit-flipped downloads
  const [withFile] = (await b.sec.decryptMessages(await list(c1.id))).filter((o) => o.ok && o.message.attachments.length).map((o) => o.message);
  const good = await b.sec.openAttachment(withFile.attachments[0]);
  check(good.bytes.length === 70_000, 'the honest download opens');
  for (const [label, cut] of [['truncated', (u) => u.slice(0, u.length - 100)], ['bit-flipped', (u) => { const c = u.slice(); c[c.length >> 1] ^= 1; return c; }], ['extended', (u) => Uint8Array.from([...u, 1, 2, 3])]]) {
    const tampered = actor(b.id, { download: async (url) => cut(new Uint8Array(await (await fetch(url)).arrayBuffer())) });
    await tampered.store.set(X.keyNames.device, await b.store.get(X.keyNames.device));
    for (const v of await b.sec.heldVersions(c1.id)) await tampered.store.set(X.keyNames.conversationKey(c1.id, v), await b.store.get(X.keyNames.conversationKey(c1.id, v)));
    const r = await fail(tampered.sec.openAttachment(withFile.attachments[0]));
    check(r instanceof Error, `a ${label} attachment is rejected`);
  }

  // a rogue device in a device list
  const rogue = { id: randomUUID(), userId: b.id, publicKey: Buffer.from(X.nobleProvider.generateKeyPair().publicKey).toString('base64url'), isPrimary: false, deviceName: 'rogue' };
  const attackerView = (autoOrConfirm) => {
    const tt = tampering();
    const u = actor(a.id, { fetch: tt.fetch, deviceTrust: autoOrConfirm });
    return { tt, u };
  };
  for (const mode of ['confirm', 'auto']) {
    const { tt, u } = attackerView(mode);
    await u.store.set(X.keyNames.device, await a.store.get(X.keyNames.device));
    for (const v of await a.sec.heldVersions(c1.id)) await u.store.set(X.keyNames.conversationKey(c1.id, v), await a.store.get(X.keyNames.conversationKey(c1.id, v)));
    tt.edit = (p, m, j) => (p === `/conversations/${c1.id}/devices` && m === 'GET' ? { ...j, data: [...j.data, rogue] } : undefined);
    const changes = [], errors = [];
    u.rekey.onDeviceChange((c) => changes.push(c)); u.rekey.onError((er) => errors.push(er));
    const before = errors.length;
    await u.rekey.handle('device.added', { userId: b.id, deviceId: rogue.id, publicKey: rogue.publicKey, conversationIds: [c1.id] });
    if (mode === 'confirm') check(changes.some((c) => c.deviceId === rogue.id && c.status === 'pending') && u.rekey.pendingDevices().some((p) => p.deviceId === rogue.id), 'deviceTrust "confirm": an injected device is held back and reported, no key sealed for it');
    else check(changes.some((c) => c.deviceId === rogue.id) || errors.length > before, 'deviceTrust "auto": an injected device is surfaced to the app (deviceChange, or the honest server refuses the upload)');
  }
}

// ============================================================ 3. mock vs real
async function parity() {
  say('\n3. The mock server and the real server answer the same');
  const run = async (env) => {
    const out = {};
    const outcome = async (key, fn) => { try { const v = await fn(); out[key] = `ok${v === undefined ? '' : ':' + v}`; } catch (e) { out[key] = `${e?.name}:${e?.status}:${e?.code}`; if (/^(TypeError|ReferenceError|RangeError|SyntaxError)$/.test(e?.name)) { failed++; say(`  FAIL  ${key}: the script itself broke (${e.name}: ${e.message})`); } } };
    const mk = async (n) => { const id = await env.newUser(n); const u = env.actor(id); await u.dev.registerPrimaryDevice({ deviceName: 'phone' }); return u; };
    const a = await mk('c-alice'), b = await mk('c-bob'), eve = await mk('c-eve');
    const dA = await a.dev.currentDevice(), dB = await b.dev.currentDevice();
    await outcome('device: register again', () => a.api.devices.register({ publicKey: dA.publicKey, deviceName: 'x' }));
    await outcome('device: bad public key', async () => { const s = env.actor(await env.newUser('c-bad')); return s.api.devices.register({ publicKey: 'AAAA', deviceName: 'x' }); });
    await outcome('device: missing X-Device-Id', () => X.apiCall(a.client, 'GET', `/conversations/${randomUUID()}/keys`, {}));
    await outcome('device: link not approved yet', () => X.linkDevice(a.client, { publicKey: Buffer.from(X.nobleProvider.generateKeyPair().publicKey).toString('base64url') }));
    await outcome('backup: none', () => a.api.backup.get());
    await outcome('backup: invalid kdf', () => a.api.backup.put({ blob: 'AAAA', kdf: { v: 1, alg: 'argon2id', m: 1, t: 1, p: 1, salt: 'AAAA' } }));
    await outcome('backup: delete twice', async () => { await a.api.backup.delete(); await a.api.backup.delete(); });
    const id = randomUUID(), ck = X.newConversationKey();
    const wrap = (convId, ver, devs, by) => X.wrapKeyForDevices({ conversationKey: ck, conversationId: convId, keyVersion: ver, sender: { deviceId: dA.deviceId, privateKey: by }, recipients: devs });
    const mine = await a.dev.requireDevice();
    const keys = wrap(id, 1, [{ deviceId: dA.deviceId, publicKey: dA.publicKey }, { deviceId: dB.deviceId, publicKey: dB.publicKey }], mine.privateKey);
    await outcome('conversation: missing a device (stale set)', () => X.createEncryptedConversation(a.client, dA.deviceId, { id: randomUUID(), type: 'direct', participantIds: [a.id, b.id], keys: keys.slice(0, 1).map((k) => ({ ...k, wrappedKey: wrap(id, 1, [{ deviceId: dA.deviceId, publicKey: dA.publicKey }], mine.privateKey)[0].wrappedKey })) }));
    await outcome('conversation: member without a device', async () => { const ghost = await env.newUser('c-ghost'); return X.createEncryptedConversation(a.client, dA.deviceId, { id: randomUUID(), type: 'direct', participantIds: [a.id, ghost], keys: keys.slice(0, 1) }); });
    await outcome('conversation: create', async () => (await X.createEncryptedConversation(a.client, dA.deviceId, { id, type: 'direct', participantIds: [a.id, b.id], keys })).min_key_version);
    await outcome('conversation: same id again', () => X.createEncryptedConversation(a.client, dA.deviceId, { id, type: 'direct', participantIds: [a.id, b.id], keys }));
    await outcome('keys: version already complete', () => X.uploadKeys(a.client, id, dA.deviceId, { keyVersion: 1, keys }));
    await outcome('keys: stranger reads', async () => X.getKeys(eve.client, id, (await eve.dev.currentDevice()).deviceId));
    await outcome('keys: member reads', async () => (await X.getKeys(b.client, id, dB.deviceId)).length);
    await outcome('devices of a conversation: stranger', async () => X.listConversationDevices(eve.client, id));
    await outcome('devices of a conversation: member', async () => (await X.listConversationDevices(b.client, id)).length);
    const msg = (ver) => X.encryptSecureMessage({ text: 'x' }, ck, { conversationId: id, keyVersion: ver, senderId: a.id });
    await outcome('message: key version that does not exist', () => X.postEncryptedMessage(a.client, { conversationId: id, senderId: a.id, content: msg(9), keyVersion: 9 }));
    await outcome('participants: remove', async () => (await X.removeParticipant(a.client, id, b.id)).minKeyVersion);
    await outcome('message: old key after removal', () => X.postEncryptedMessage(a.client, { conversationId: id, senderId: a.id, content: msg(1), keyVersion: 1 }));
    return out;
  };
  const mock = testing.createMockServer();
  const mockEnv = {
    newUser: async () => mock.addUser(),
    actor: (id) => { const store = X.memoryKeyStore(); const client = X.withCrypto(core.createClient({ baseUrl: 'http://mock', token: mock.tokenFor(id), fetch: mock.fetch, maxRetries: 0 }), { keyStore: store, userId: id, jitterMs: 0 }); const c = client.crypto; return { id, client, dev: c.device, api: c, sec: c.secure }; },
  };
  const realEnv = { newUser: (n) => newUser(n), actor: (id) => { const u = actor(id); return { id, client: u.client, dev: u.dev, api: u.api, sec: u.sec }; } };
  const [m, r] = [await run(mockEnv), await run(realEnv)];
  for (const k of Object.keys(m)) {
    const same = m[k] === r[k];
    check(same, `${k}  ->  ${r[k]}`, same ? undefined : `mock says "${m[k]}", real server says "${r[k]}" (update the mock or the server contract)`);
  }
}

say(`Server: ${BASE}`);
const alive = await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false);
if (!alive) { console.error(`Cannot reach ${BASE}/api/health. Is the server running?`); process.exit(2); }
const probeId = await newUser('probe').catch((e) => {
  console.error(e?.status === 401 ? 'The server rejected the test token: JWT_SECRET does not match the server.' : `Could not create a test user (${e?.status ?? ''} ${e?.code ?? e?.message}). The project ${PROJECT} must exist: on a dev database run  psql "$DATABASE_URL" -f scripts/smoke-seed.sql  (or set PROJECT_ID / ORG_ID to your own).`);
  process.exit(2);
});
const probe = actor(probeId);
const flag = await fail(probe.api.devices.list([probe.id]));
if (flag && flag.status === 404) { console.error('The server has E2EE switched off (the device routes answer 404). Set E2EE_ENABLED=on and restart it.'); process.exit(2); }
await settle('lifecycle', lifecycle);
await settle('malicious server', malicious);
await settle('parity', parity);
say(failed ? `\n${failed} CHECK(S) FAILED` : '\nVERIFY-CRYPTO PASSED');
process.exit(failed ? 1 : 0);
