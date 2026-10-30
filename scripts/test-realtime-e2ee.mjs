// E2EE Stage 7.6 end-to-end check against a RUNNING server with realtime on AND E2EE on:
//
//   E2EE_ENABLED=on REALTIME_PROVIDER=socketio npm run dev:socket     # terminal 1 (after db:migrate + smoke-seed.sql)
//   JWT_SECRET=... DATABASE_URL=... node scripts/test-realtime-e2ee.mjs   # terminal 2 (same JWT_SECRET as the server)
//
// DEV/STAGING ONLY: creates temporary users, devices and conversations and deletes them again.
// Checks: sockets auto-join user:<id>; device.added reaches the linking user and co-members (with SHARED conversation ids)
// and nobody else; device.removed; keys.updated; keys.requested; a plain-token socket gets nothing.
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const { Client } = require('pg');
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000a2';
const SECRET = process.env.JWT_SECRET;
if (!SECRET || !process.env.DATABASE_URL) { console.error('set JWT_SECRET and DATABASE_URL (same as the server)'); process.exit(2); }

let failed = 0;
const check = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pub = () => randomBytes(32).toString('base64url');
const wrapped = () => randomBytes(73).toString('base64url');
const tok = (userId) => jwt.sign({ projectId: PROJECT, organizationId: ORG, type: userId ? 'user' : 'api', ...(userId && { userId }) }, SECRET, { expiresIn: '1h' });
const api = async (method, p, { userId, body, device } = {}) => {
  const r = await fetch(`${BASE}/api/v1${p}`, { method, headers: { authorization: `Bearer ${tok(userId)}`, 'content-type': 'application/json', ...(device ? { 'x-device-id': device } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const users = [], convs = [], sockets = [];
const mkUser = async () => { const id = (await db.query('INSERT INTO mx_users (project_id, name) VALUES ($1,$2) RETURNING id', [PROJECT, 'rt-e2ee'])).rows[0].id; users.push(id); return id; };
const mkDeviceUser = async () => { const id = await mkUser(); const r = await api('POST', '/devices', { userId: id, body: { publicKey: pub() } }); return { id, device: r.json.data?.id }; };
const connect = async (userId) => {
  const s = io(BASE, { auth: { token: tok(userId) }, transports: ['websocket'], reconnection: false, forceNew: true });
  sockets.push(s);
  await new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); });
  return s;
};
const record = (s, ...names) => { const got = []; for (const n of names) s.on(n, (d) => got.push({ n, d })); return got; };
const settle = async (got, ms = 5000, quiet = 1200) => { const end = Date.now() + ms; while (!got.length && Date.now() < end) await sleep(25); await sleep(got.length ? 200 : quiet); return got; };
const EVENTS = ['device.added', 'device.removed', 'keys.updated', 'keys.requested'];

try {
  const a = await mkDeviceUser();           // will link a second device
  const b = await mkDeviceUser();           // shares conversation 1 with A
  const c = await mkDeviceUser();           // shares conversation 2 with A
  const stranger = await mkDeviceUser();    // shares nothing with A

  const mkConv = async (owner, others) => {
    const members = [owner, ...others];
    const r = await api('POST', '/conversations', { userId: owner.id, device: owner.device, body: { type: 'group', title: 'rt-e2ee', participantIds: members.map((m) => m.id), encryptionMode: 'e2ee-v1', keys: members.map((m) => ({ deviceId: m.device, wrappedKey: wrapped(), wrappedByDeviceId: owner.device })) } });
    if (r.status !== 201) throw new Error(`create conversation failed: ${r.status} ${JSON.stringify(r.json)}`);
    convs.push(r.json.data.id);
    return r.json.data.id;
  };

  console.log('== keys.updated on create (conversation 1: A + B)');
  const sa = await connect(a.id), sb = await connect(b.id), sc = await connect(c.id), sx = await connect(stranger.id);
  const sApi = io(BASE, { auth: { token: tok() }, transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(sApi);
  await new Promise((res, rej) => { sApi.once('connect', res); sApi.once('connect_error', rej); });
  let ra = record(sa, ...EVENTS), rb = record(sb, ...EVENTS), rc = record(sc, ...EVENTS), rx = record(sx, ...EVENTS), rApi = record(sApi, ...EVENTS);
  const conv1 = await mkConv(a, [b]);
  await settle(rb);
  check(rb.some((e) => e.n === 'keys.updated' && e.d.conversationId === conv1 && e.d.keyVersion === 1 && e.d.deviceIds.length === 1 && e.d.deviceIds[0] === b.device), 'B (target) receives keys.updated for conversation 1 with only B\'s device');
  check(ra.some((e) => e.n === 'keys.updated' && e.d.conversationId === conv1), 'A (creator, also a target) receives keys.updated');
  check(rx.length === 0 && rc.length === 0 && rApi.length === 0, 'a stranger, a non-member and an api-token socket receive nothing');

  const conv2 = await mkConv(a, [c]);
  await sleep(500);

  console.log('== device.added on link: A links a second device');
  ra.length = rb.length = rc.length = rx.length = rApi.length = 0;
  const newKey = pub();
  const ap = await api('POST', '/devices/pair', { userId: a.id, device: a.device, body: { publicKey: newKey } });
  check(ap.status === 200, 'primary approves the new key');
  const lk = await api('POST', '/devices/link', { userId: a.id, body: { publicKey: newKey, deviceName: 'rt-phone' } });
  check(lk.status === 201, 'new device links');
  const newDevice = lk.json.data?.id;
  await Promise.all([settle(ra), settle(rb), settle(rc)]);
  const added = (r) => r.filter((e) => e.n === 'device.added').map((e) => e.d);
  check(added(ra).length === 1 && added(ra)[0].deviceId === newDevice && added(ra)[0].publicKey === newKey && added(ra)[0].conversationIds.length === 2, 'A (own other device) receives device.added with both e2ee conversation ids');
  check(added(rb).length === 1 && JSON.stringify(added(rb)[0].conversationIds) === JSON.stringify([conv1]), 'B receives device.added with ONLY the shared conversation (1)');
  check(added(rc).length === 1 && JSON.stringify(added(rc)[0].conversationIds) === JSON.stringify([conv2]), 'C receives device.added with ONLY the shared conversation (2)');
  check(rx.length === 0 && rApi.length === 0, 'the stranger and the api-token socket receive nothing');

  console.log('== keys.updated on key upload (wrap conversation 1 for the new device)');
  ra.length = rb.length = rc.length = 0;
  const up = await api('POST', `/conversations/${conv1}/keys`, { userId: a.id, device: a.device, body: { keyVersion: 1, keys: [{ deviceId: newDevice, wrappedKey: wrapped(), wrappedByDeviceId: a.device }] } });
  check(up.status === 201, 'upload wrap for the new device -> 201');
  await settle(ra);
  check(ra.length === 1 && ra[0].n === 'keys.updated' && JSON.stringify(ra[0].d.deviceIds) === JSON.stringify([newDevice]), 'A receives keys.updated naming the new device');
  check(rb.length === 0, 'B (not a target) receives nothing');

  console.log('== keys.requested');
  ra.length = rb.length = rc.length = 0;
  const rq = await api('POST', `/conversations/${conv1}/keys/request`, { userId: a.id, device: newDevice, body: { keyVersion: 1 } });
  check(rq.status === 202, 'new device asks for the key -> 202');
  await settle(rb);
  check(rb.some((e) => e.n === 'keys.requested' && e.d.conversationId === conv1 && e.d.requestingDeviceId === newDevice && e.d.keyVersion === 1), 'B (other participant) receives keys.requested');
  check(ra.length === 0 && rc.length === 0, 'the requester and non-participants do not');

  console.log('== device.removed on revoke');
  ra.length = rb.length = rc.length = 0;
  const del = await api('DELETE', `/devices/${newDevice}`, { userId: a.id });
  check(del.status === 200, 'revoke the new device');
  await Promise.all([settle(ra), settle(rb), settle(rc)]);
  const removed = (r) => r.filter((e) => e.n === 'device.removed').map((e) => e.d);
  check(removed(ra).length === 1 && removed(ra)[0].deviceId === newDevice, 'A receives device.removed');
  check(removed(rb).length === 1 && JSON.stringify(removed(rb)[0].conversationIds) === JSON.stringify([conv1]), 'B receives device.removed with the shared conversation');
  check(removed(rc).length === 1 && removed(rx).length === 0, 'C receives it; the stranger does not');
} finally {
  for (const s of sockets) s.close();
  if (convs.length) await db.query('DELETE FROM mx_conversations WHERE id = ANY($1::uuid[])', [convs]).catch(() => {});
  if (users.length) await db.query('DELETE FROM mx_users WHERE id = ANY($1::uuid[])', [users]).catch(() => {});
  await db.end().catch(() => {});
}
console.log(failed ? '\nFAILED' : '\nALL GOOD');
process.exit(failed);
