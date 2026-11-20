#!/usr/bin/env node
// HTTP contract check for the Messaging Express E2EE API (docs/e2ee/api.md, version 1).
// Point it at ANY backend that claims to implement the contract: this module, the hosted server, or your own. Plain Node 20+,
// no dependencies. It creates users, conversations and messages (and, if uploads are configured, one file): run it against a
// development or staging deployment, never production.
//
//   BASE_URL=http://localhost:3000/chat JWT_SECRET=<the backend's secret> node contract.mjs
//
// Tokens are minted as HS256 JWTs from JWT_SECRET: { type: 'api' } and { type: 'user', userId } (add PROJECT_ID and
// ORGANIZATION_ID for a multi-tenant deployment). If your backend authenticates differently, replace `mint()` below.
// The backend must have E2EE on. Exit code 0 = every check passed (skips are listed and do not fail the run).
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('Set JWT_SECRET to the backend\'s token secret (and BASE_URL if it is not http://localhost:3000).'); process.exit(2); }
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mint = (claims) => {
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...claims, ...(process.env.PROJECT_ID ? { projectId: process.env.PROJECT_ID } : {}), ...(process.env.ORGANIZATION_ID ? { organizationId: process.env.ORGANIZATION_ID } : {}), iat: now, exp: now + 3600 })}`;
  return `${head}.${createHmac('sha256', SECRET).update(head).digest('base64url')}`;
};
const API = mint({ type: 'api' });
const key = () => randomBytes(32).toString('base64url'); // a public key is 32 opaque bytes to the server
const wrapped = () => randomBytes(60).toString('base64url'); // opaque: the server checks size and encoding only
const ciphertext = () => Buffer.concat([Buffer.from([1]), randomBytes(60)]).toString('base64url'); // first byte 0x01, >= 41 bytes

async function http(method, path, { token = API, device, body } = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(device ? { 'x-device-id': device } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, code: json?.error?.code, data: json?.data, details: json?.error?.details };
}

let passed = 0, failed = 0; const skipped = [];
async function check(name, fn) {
  try { const r = await fn(); if (r === 'skip') { skipped.push(name); console.log(`  --   ${name}`); } else { passed++; console.log(`  ok   ${name}`); } }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const eq = (actual, expected, what) => { if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };
const run = randomUUID().slice(0, 8);
const newUser = async (name) => { const r = await http('POST', '/users', { body: { externalId: `${name}-${run}`, name } }); eq(r.status < 300, true, `create user ${name} (${r.status} ${JSON.stringify(r.json)})`); return { id: r.data.id, token: mint({ type: 'user', userId: r.data.id }) }; };
const register = async (u) => { const r = await http('POST', '/devices', { token: u.token, body: { publicKey: key(), deviceName: 'conformance' } }); eq(r.status, 201, `register device (${JSON.stringify(r.json)})`); return r.data.id; };

console.log(`Contract check against ${BASE}\n`);
const alice = await newUser('alice'), bob = await newUser('bob'), eve = await newUser('eve'), carol = await newUser('carol');

console.log('Conventions');
await check('a request without a token is 401', async () => eq((await http('GET', '/devices?userIds=x', { token: null })).status, 401, 'status'));
await check('errors are { error: { message, code } }', async () => { const r = await http('POST', '/devices', { token: alice.token, body: { publicKey: 'short' } }); eq(r.status, 400, 'status'); eq(r.code, 'VALIDATION_ERROR', 'code'); eq(typeof r.json.error.message, 'string', 'message'); });
await check('device routes need a user token (api token: 403)', async () => eq((await http('POST', '/devices', { body: { publicKey: key() } })).status, 403, 'status'));

console.log('\nDevices');
let aliceDev, bobDev, carolDev;
await check('register the first device: 201, primary', async () => { const r = await http('POST', '/devices', { token: alice.token, body: { publicKey: key(), deviceName: 'phone' } }); eq(r.status, 201, 'status'); eq(r.data.isPrimary, true, 'isPrimary'); aliceDev = r.data.id; });
await check('a second first-registration is 409 DEVICE_EXISTS', async () => { const r = await http('POST', '/devices', { token: alice.token, body: { publicKey: key() } }); eq(r.status, 409, 'status'); eq(r.code, 'DEVICE_EXISTS', 'code'); });
bobDev = await register(bob); carolDev = await register(carol);
await check('GET /devices lists active devices with the documented shape', async () => {
  const r = await http('GET', `/devices?userIds=${alice.id},${bob.id},${randomUUID()}`, { token: alice.token });
  eq(r.status, 200, 'status'); eq(r.data.length, 2, 'unknown ids yield no rows');
  const d = r.data.find((x) => x.id === aliceDev); eq(!!d && d.userId === alice.id && d.isPrimary === true && typeof d.publicKey === 'string' && 'deviceName' in d, true, 'item shape');
});
await check('a [Dev] route without X-Device-Id is 403 DEVICE_REQUIRED, with a foreign one DEVICE_INVALID', async () => {
  const none = await http('POST', '/devices/pair', { token: alice.token, body: { publicKey: key() } }); eq(none.status, 403, 'status'); eq(none.code, 'DEVICE_REQUIRED', 'code');
  const foreign = await http('POST', '/devices/pair', { token: alice.token, device: bobDev, body: { publicKey: key() } }); eq(foreign.code, 'DEVICE_INVALID', 'foreign device');
});
await check('pair then link: 404 PAIRING_NOT_FOUND before approval, 201 with devices after, approval used once', async () => {
  const newKey = key();
  const early = await http('POST', '/devices/link', { token: alice.token, body: { publicKey: newKey } }); eq(early.status, 404, 'before approval'); eq(early.code, 'PAIRING_NOT_FOUND', 'code');
  const pair = await http('POST', '/devices/pair', { token: alice.token, device: aliceDev, body: { publicKey: newKey } }); eq(pair.status, 200, `pair (${JSON.stringify(pair.json)})`); eq(typeof pair.data.expiresAt, 'string', 'expiresAt');
  const link = await http('POST', '/devices/link', { token: alice.token, body: { publicKey: newKey, deviceName: 'laptop' } });
  eq(link.status, 201, 'link'); eq(link.data.isPrimary, false, 'isPrimary'); eq(Array.isArray(link.data.devices) && Array.isArray(link.data.conversationIds), true, 'devices and conversationIds');
  eq((await http('POST', '/devices/link', { token: alice.token, body: { publicKey: newKey } })).status, 404, 'second use');
  eq((await http('DELETE', `/devices/${link.data.id}`, { token: alice.token })).status, 200, 'revoke the companion'); // keep one device per person for the rest
});

console.log('\nBackup');
const kdf = { v: 1, alg: 'argon2id', m: 1024, t: 1, p: 1, salt: randomBytes(16).toString('base64url') };
await check('PUT, GET and DELETE /devices/backup; unknown kdf fields are rejected', async () => {
  eq((await http('GET', '/devices/backup', { token: alice.token })).status, 404, 'no backup yet');
  eq((await http('PUT', '/devices/backup', { token: alice.token, body: { blob: randomBytes(100).toString('base64url'), kdf: { ...kdf, extra: 1 } } })).status, 400, 'unknown field');
  eq((await http('PUT', '/devices/backup', { token: alice.token, body: { blob: randomBytes(100).toString('base64url'), kdf } })).status, 200, 'put');
  const got = await http('GET', '/devices/backup', { token: alice.token }); eq(got.status, 200, 'get'); eq(got.data.kdf.alg, 'argon2id', 'kdf round trip');
  const del = await http('DELETE', '/devices/backup', { token: alice.token }); eq(del.status, 200, 'delete'); eq(del.data.deleted, true, 'deleted');
});

console.log('\nEncrypted conversations');
const convId = randomUUID();
const keysFor = (devs, by) => devs.map((d) => ({ deviceId: d, wrappedKey: wrapped(), wrappedByDeviceId: by }));
await check('create: 201 with the client-chosen id, e2ee-v1 and min_key_version 1', async () => {
  const r = await http('POST', '/conversations', { token: alice.token, device: aliceDev, body: { id: convId, type: 'group', encryptionMode: 'e2ee-v1', participantIds: [alice.id, bob.id], keys: keysFor([aliceDev, bobDev], aliceDev) } });
  eq(r.status, 201, `status (${JSON.stringify(r.json)})`); eq(r.data.id, convId, 'client-chosen id'); eq(r.data.encryption_mode, 'e2ee-v1', 'mode'); eq(r.data.min_key_version, 1, 'min_key_version');
});
await check('create with a taken id is 409 CONVERSATION_EXISTS', async () => { const r = await http('POST', '/conversations', { token: alice.token, device: aliceDev, body: { id: convId, type: 'group', encryptionMode: 'e2ee-v1', participantIds: [alice.id, bob.id], keys: keysFor([aliceDev, bobDev], aliceDev) } }); eq(r.status, 409, 'status'); eq(r.code, 'CONVERSATION_EXISTS', 'code'); });
await check('create with an incomplete device set is 409 STALE_DEVICE_SET naming the required ids', async () => {
  const r = await http('POST', '/conversations', { token: alice.token, device: aliceDev, body: { type: 'group', encryptionMode: 'e2ee-v1', participantIds: [alice.id, bob.id], keys: keysFor([aliceDev], aliceDev) } });
  eq(r.status, 409, 'status'); eq(r.code, 'STALE_DEVICE_SET', 'code'); eq([...r.details.deviceIds].sort().join(), [aliceDev, bobDev].sort().join(), 'details.deviceIds');
});
await check('create with a participant who has no device is 409 PARTICIPANT_HAS_NO_DEVICE', async () => {
  const noDev = await newUser('nodevice');
  const r = await http('POST', '/conversations', { token: alice.token, device: aliceDev, body: { type: 'group', encryptionMode: 'e2ee-v1', participantIds: [alice.id, noDev.id], keys: keysFor([aliceDev], aliceDev) } });
  eq(r.status, 409, 'status'); eq(r.code, 'PARTICIPANT_HAS_NO_DEVICE', 'code'); eq(r.details.userIds[0], noDev.id, 'details.userIds');
});
await check('keys without encryptionMode e2ee-v1 is 400', async () => eq((await http('POST', '/conversations', { token: alice.token, device: aliceDev, body: { type: 'group', participantIds: [alice.id, bob.id], keys: keysFor([aliceDev, bobDev], aliceDev) } })).status, 400, 'status'));
await check('GET keys [Dev]: the caller’s rows in key_version order; DEVICE_REQUIRED without the header', async () => {
  const r = await http('GET', `/conversations/${convId}/keys`, { token: bob.token, device: bobDev });
  eq(r.status, 200, 'status'); eq(r.data.length, 1, 'rows'); eq(r.data[0].keyVersion, 1, 'keyVersion'); eq(typeof r.data[0].wrappedByPublicKey, 'string', 'wrappedByPublicKey');
  eq((await http('GET', `/conversations/${convId}/keys`, { token: bob.token })).code, 'DEVICE_REQUIRED', 'header');
});
await check('a non-participant cannot read the keys, the devices or the messages (403)', async () => {
  const eveDev = await register(eve);
  eq((await http('GET', `/conversations/${convId}/keys`, { token: eve.token, device: eveDev })).status, 403, 'keys');
  eq((await http('GET', `/conversations/${convId}/devices`, { token: eve.token })).status, 403, 'devices');
  eq((await http('GET', `/messages?conversationId=${convId}`, { token: eve.token })).status, 403, 'messages');
});
await check('GET /conversations/:id/devices lists the current participants’ devices', async () => { const r = await http('GET', `/conversations/${convId}/devices`, { token: alice.token }); eq(r.status, 200, 'status'); eq(r.data.length, 2, 'devices'); });
await check('POST keys for an existing version: KEY_EXISTS when nothing new is inserted', async () => {
  const r = await http('POST', `/conversations/${convId}/keys`, { token: alice.token, device: aliceDev, body: { keyVersion: 1, keys: keysFor([bobDev], aliceDev) } });
  eq(r.status, 409, 'status'); eq(r.code, 'KEY_EXISTS', 'code');
});
await check('POST keys with a version beyond latest + 1 is 400', async () => eq((await http('POST', `/conversations/${convId}/keys`, { token: alice.token, device: aliceDev, body: { keyVersion: 5, keys: keysFor([aliceDev, bobDev], aliceDev) } })).status, 400, 'status'));
await check('POST keys/request [Dev]: 202', async () => { const r = await http('POST', `/conversations/${convId}/keys/request`, { token: bob.token, device: bobDev, body: {} }); eq(r.status, 202, 'status'); eq(r.data.requested, true, 'requested'); });

console.log('\nMessages in an encrypted conversation');
const send = (u, meta, content) => http('POST', '/messages', { token: u.token, body: { conversationId: convId, senderId: u.id, content, type: 'text', metadata: meta } });
await check('a well-formed message is 201 and comes back as ciphertext + metadata', async () => {
  const content = ciphertext(); const r = await send(alice, { scheme: 'ck-xchacha-v1', key_version: 1 }, content); eq(r.status, 201, `status (${JSON.stringify(r.json)})`);
  const list = await http('GET', `/messages?conversationId=${convId}`, { token: bob.token }); eq(list.status, 200, 'list'); eq(list.data.some((m) => m.content === content), true, 'stored as sent');
});
await check('plaintext, a wrong scheme, a bad version byte and a too-high key_version are 400', async () => {
  eq((await send(alice, {}, 'hello in the clear')).status, 400, 'plaintext');
  eq((await send(alice, { scheme: 'other', key_version: 1 }, ciphertext())).status, 400, 'scheme');
  eq((await send(alice, { scheme: 'ck-xchacha-v1', key_version: 1 }, Buffer.concat([Buffer.from([2]), randomBytes(60)]).toString('base64url'))).status, 400, 'version byte');
  eq((await send(alice, { scheme: 'ck-xchacha-v1', key_version: 9 }, ciphertext())).status, 400, 'key_version above the latest');
});
await check('an attachment on an e2ee message must be an opaque blob', async () => {
  const body = (att) => ({ conversationId: convId, senderId: alice.id, content: ciphertext(), type: 'text', metadata: { scheme: 'ck-xchacha-v1', key_version: 1 }, attachments: [att] });
  const bad = await http('POST', '/messages', { token: alice.token, body: body({ type: 'image', url: 'https://files.test/a.png', mimeType: 'image/png', sizeBytes: 5 }) }); eq(bad.status, 400, 'image/png');
  const ok = await http('POST', '/messages', { token: alice.token, body: body({ type: 'file', url: 'https://files.test/a.bin', mimeType: 'application/octet-stream', sizeBytes: 5 }) }); eq(ok.status, 201, `opaque (${JSON.stringify(ok.json)})`);
});
await check('a user token can only send as itself (403)', async () => eq((await http('POST', '/messages', { token: alice.token, body: { conversationId: convId, senderId: bob.id, content: ciphertext(), type: 'text', metadata: { scheme: 'ck-xchacha-v1', key_version: 1 } } })).status, 403, 'status'));
await check('a request with metadata.scheme on a plain conversation is 400', async () => {
  const plain = await http('POST', '/conversations', { token: alice.token, body: { type: 'group', participantIds: [alice.id, bob.id] } }); eq(plain.status, 201, 'plain conversation');
  eq((await http('POST', '/messages', { token: alice.token, body: { conversationId: plain.data.id, senderId: alice.id, content: 'x', type: 'text', metadata: { scheme: 'ck-xchacha-v1', key_version: 1 } } })).status, 400, 'status');
});

console.log('\nParticipants and rotation');
await check('adding a user without a device to an e2ee conversation is 409 PARTICIPANT_HAS_NO_DEVICE', async () => {
  const noDev = await newUser('nodevice2'); const r = await http('POST', `/conversations/${convId}/participants`, { token: alice.token, body: { userId: noDev.id } }); eq(r.status, 409, 'status'); eq(r.code, 'PARTICIPANT_HAS_NO_DEVICE', 'code');
});
await check('adding is idempotent: 201 then 200', async () => { eq((await http('POST', `/conversations/${convId}/participants`, { token: alice.token, body: { userId: carol.id } })).status, 201, 'first'); eq((await http('POST', `/conversations/${convId}/participants`, { token: alice.token, body: { userId: carol.id } })).status, 200, 'repeat'); });
await check('removing raises the floor: the old key_version is 409 KEY_ROTATION_REQUIRED, a repeat removal is 404', async () => {
  const rm = await http('DELETE', `/conversations/${convId}/participants/${carol.id}`, { token: alice.token }); eq(rm.status, 200, 'remove'); eq(rm.data.minKeyVersion, 2, 'minKeyVersion');
  const old = await send(alice, { scheme: 'ck-xchacha-v1', key_version: 1 }, ciphertext()); eq(old.status, 409, 'old version'); eq(old.code, 'KEY_ROTATION_REQUIRED', 'code'); eq(old.details.minKeyVersion, 2, 'details.minKeyVersion');
  eq((await http('DELETE', `/conversations/${convId}/participants/${carol.id}`, { token: alice.token })).status, 404, 'repeat removal');
  eq((await http('GET', `/messages?conversationId=${convId}`, { token: carol.token })).status, 403, 'the removed user reads nothing');
});
await check('a rotation (version 2) must cover exactly the current devices, then messages at version 2 are accepted', async () => {
  const partial = await http('POST', `/conversations/${convId}/keys`, { token: alice.token, device: aliceDev, body: { keyVersion: 2, keys: keysFor([aliceDev], aliceDev) } }); eq(partial.status, 409, 'partial'); eq(partial.code, 'STALE_DEVICE_SET', 'code');
  const full = await http('POST', `/conversations/${convId}/keys`, { token: alice.token, device: aliceDev, body: { keyVersion: 2, keys: keysFor([aliceDev, bobDev], aliceDev) } }); eq(full.status, 201, `full (${JSON.stringify(full.json)})`); eq(full.data.inserted, 2, 'inserted');
  eq((await send(alice, { scheme: 'ck-xchacha-v1', key_version: 2 }, ciphertext())).status, 201, 'message at the new version');
});

console.log('\nAdmin and uploads');
await check('admin reset revokes all of a user’s devices (api token); a user token is 403', async () => {
  eq((await http('POST', `/users/${bob.id}/devices/reset`, { token: bob.token })).status, 403, 'user token');
  const r = await http('POST', `/users/${bob.id}/devices/reset`, {}); eq(r.status, 200, 'status'); eq(r.data.revoked, 1, 'revoked');
  eq((await http('GET', `/devices?userIds=${bob.id}`, { token: alice.token })).data.length, 0, 'no active devices left');
});
await check('uploads: category=e2ee accepts application/octet-stream (skipped when uploads are not configured)', async () => {
  const form = new FormData(); form.append('category', 'e2ee'); form.append('file', new File([randomBytes(64)], 'encrypted.bin', { type: 'application/octet-stream' }));
  const res = await fetch(`${BASE}/api/v1/uploads`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}` }, body: form });
  if (res.status === 501) return 'skip';
  eq(res.status, 200, 'status'); const j = await res.json(); eq(typeof j.data?.[0]?.url, 'string', `url (${JSON.stringify(j)})`);
  const plain = new FormData(); plain.append('file', new File([randomBytes(64)], 'x.bin', { type: 'application/octet-stream' }));
  const refused = await (await fetch(`${BASE}/api/v1/uploads`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}` }, body: plain })).json();
  eq(typeof refused.data?.[0]?.error, 'string', 'without category=e2ee the opaque type is refused');
});

console.log(`\n${passed} passed, ${failed} failed${skipped.length ? `, ${skipped.length} skipped` : ''}`);
process.exit(failed ? 1 : 0);
