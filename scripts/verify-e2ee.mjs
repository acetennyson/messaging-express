// One-command check of the E2EE work, against YOUR dev database and running dev server. Works on Windows, macOS, Linux.
// DEV / STAGING ONLY: it runs the idempotent smoke seed, creates a few temporary users, and deletes them again.
//
//   1) npm run db:migrate
//   2) terminal 1:   set E2EE_ENABLED=on   (PowerShell: $env:E2EE_ENABLED="on")   then   npm run dev
//   3) terminal 2:   npm run verify:e2ee
//
// Run it once with E2EE_ENABLED unset too: the "flag off" section then checks that every E2EE route is a 404.
// Reads DATABASE_URL and JWT_SECRET from .env.local / .env by itself. Options: BASE_URL=http://localhost:3000
//
// Each stage of Stage 7 adds its own section below; this one file stays the single thing to run.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

for (const name of ['.env.local', '.env']) {
  const file = path.join(root, name);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000a2';
const say = (s = '') => console.log(s);
let failed = 0;
let passed = 0;
const check = (cond, label, hint) => {
  say(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (cond) passed += 1;
  else {
    failed += 1;
    if (hint) say(`        -> ${hint}`);
  }
};
const section = (t) => say(`\n== ${t}`);
const die = (msg) => {
  say(`\nCannot continue: ${msg}`);
  process.exit(2);
};

if (!process.env.DATABASE_URL) die('DATABASE_URL is not set (put it in .env.local).');
if (!process.env.JWT_SECRET) die('JWT_SECRET is not set (put it in .env.local).');

const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const tokenFor = (userId, projectId = PROJECT) =>
  jwt.sign({ projectId, organizationId: ORG, type: userId ? 'user' : 'api', ...(userId && { userId }) }, process.env.JWT_SECRET, { expiresIn: '1h' });
const pubKey = () => randomBytes(32).toString('base64url');
const wrapped = () => randomBytes(73).toString('base64url'); // same size as a real wrapped conversation key

async function api(method, p, { userId, body, headers } = {}) {
  const res = await fetch(`${BASE}/api/v1${p}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(userId)}`, 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json, headers: res.headers };
}

const created = [];
const convIds = [];
async function newUser() {
  const r = await db.query('INSERT INTO mx_users (project_id, name) VALUES ($1, $2) RETURNING id', [PROJECT, 'verify-e2ee']);
  created.push(r.rows[0].id);
  return r.rows[0].id;
}

try {
  // ------------------------------------------------------------------ seed + server reachable
  const seed = path.join(root, 'scripts', 'smoke-seed.sql');
  if (existsSync(seed)) await db.query(readFileSync(seed, 'utf8'));
  let health;
  try { health = await fetch(`${BASE}/api/health`); } catch { /* handled below */ }
  if (!health || !health.ok) die(`no server answering at ${BASE}. Start it first: npm run dev`);

  // ------------------------------------------------------------------ Stage 7.1: database
  section('Stage 7.1: database objects (migration ran)');
  const tables = await db.query(
    `SELECT tablename FROM pg_tables WHERE tablename IN ('mx_devices','mx_conversation_keys','mx_pairing_requests','mx_key_backups')`
  );
  check(tables.rows.length === 4, 'the four E2EE tables exist', 'run: npm run db:migrate');
  const cols = await db.query(
    `SELECT column_name, column_default FROM information_schema.columns
     WHERE table_name = 'mx_conversations' AND column_name IN ('encryption_mode','min_key_version')`
  );
  check(cols.rows.length === 2, 'mx_conversations has encryption_mode and min_key_version', 'run: npm run db:migrate');
  const existing = await db.query(`SELECT count(*)::int AS n FROM mx_conversations WHERE encryption_mode = 'none' AND min_key_version <> 1`);
  check(existing.rows[0].n === 0, 'ordinary conversations read encryption_mode none / min_key_version 1');

  if (tables.rows.length === 4) {
    const probe = async (label, sql, params) => {
      await db.query('BEGIN');
      let rejected = false;
      try { await db.query(sql, params); } catch { rejected = true; }
      await db.query('ROLLBACK');
      check(rejected, label);
    };
    const u = await newUser();
    await db.query('BEGIN');
    await db.query(`INSERT INTO mx_devices (project_id, user_id, public_key, is_primary) VALUES ($1,$2,$3,true)`, [PROJECT, u, pubKey()]);
    let dupPrimary = false;
    await db.query('SAVEPOINT s');
    try { await db.query(`INSERT INTO mx_devices (project_id, user_id, public_key, is_primary) VALUES ($1,$2,$3,true)`, [PROJECT, u, pubKey()]); }
    catch { dupPrimary = true; await db.query('ROLLBACK TO s'); }
    await db.query('ROLLBACK');
    check(dupPrimary, 'database refuses a second active primary device for one user');
    const conv = (await db.query(`SELECT id FROM mx_conversations LIMIT 1`)).rows[0];
    if (conv) await probe('database refuses an invalid encryption_mode', `UPDATE mx_conversations SET encryption_mode = 'bogus' WHERE id = $1`, [conv.id]);
  }

  // ------------------------------------------------------------------ flag state
  const user = await newUser();
  const probeRes = await api('POST', '/devices', { userId: user, body: { publicKey: pubKey() } });
  const flagOn = probeRes.status !== 404;

  section('Existing routes unchanged by the flag');
  const pre = await fetch(`${BASE}/api/v1/devices`, {
    method: 'OPTIONS',
    headers: { origin: 'http://verify.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-device-id' },
  });
  check((pre.headers.get('access-control-allow-headers') || '').toLowerCase().includes('x-device-id'), 'CORS preflight allows the X-Device-Id header');
  const conv = await api('GET', '/conversations?limit=1', { userId: undefined });
  check(conv.status === 200, 'GET /conversations still works', `got ${conv.status}`);
  if (conv.json?.data?.[0]) {
    check(conv.json.data[0].encryption_mode === 'none' && conv.json.data[0].min_key_version === 1, 'conversation rows show encryption_mode "none" and min_key_version 1');
  }

  if (!flagOn) {
    // ---------------------------------------------------------------- flag OFF
    section('Stage 7.2: E2EE_ENABLED is OFF on the server (checking that E2EE routes are invisible)');
    check(probeRes.json?.error?.code === 'NOT_FOUND', 'POST /devices -> 404 NOT_FOUND');
    check((await api('GET', `/devices?userIds=${user}`, { userId: user })).status === 404, 'GET /devices -> 404');
    check((await api('DELETE', `/devices/${randomUUID()}`, { userId: user })).status === 404, 'DELETE /devices/:id -> 404');
    const noAuth = await fetch(`${BASE}/api/v1/devices`, { method: 'POST', body: '{}' });
    check(noAuth.status === 401, 'without a token it is still 401 (auth runs first)');
    check((await db.query('SELECT 1 FROM mx_devices WHERE user_id = $1', [user])).rows.length === 0, 'nothing was written to mx_devices');
    check((await api('POST', '/devices/pair', { userId: user, body: { publicKey: pubKey() }, headers: { 'x-device-id': randomUUID() } })).status === 404, 'POST /devices/pair -> 404');
    check((await api('POST', '/devices/link', { userId: user, body: { publicKey: pubKey() } })).status === 404, 'POST /devices/link -> 404');
    check((await api('POST', `/users/${user}/devices/reset`)).status === 404, 'POST /users/:id/devices/reset -> 404');
    const offConv = await api('POST', '/conversations', { userId: user, body: { type: 'group', participantIds: [user], encryptionMode: 'e2ee-v1', keys: [{ deviceId: randomUUID(), wrappedKey: wrapped(), wrappedByDeviceId: randomUUID() }] } });
    check(offConv.status === 400, 'creating an e2ee-v1 conversation -> 400 (not enabled)');
    const offNone = await api('POST', '/conversations', { userId: user, body: { type: 'group', participantIds: [user], encryptionMode: 'none' } });
    check(offNone.status === 201 && offNone.json?.data?.encryption_mode === 'none', 'encryptionMode "none" is still accepted');
    check((await api('GET', `/conversations/${randomUUID()}/keys`, { userId: user, headers: { 'x-device-id': randomUUID() } })).status === 404, 'GET /conversations/:id/keys -> 404');
    check((await api('POST', `/conversations/${randomUUID()}/keys/request`, { userId: user, headers: { 'x-device-id': randomUUID() } })).status === 404, 'POST /conversations/:id/keys/request -> 404');
    say('\n  To test the real behaviour, restart the server with E2EE_ENABLED=on and run this again.');
  } else {
    // ---------------------------------------------------------------- flag ON
    section('Stage 7.2: device registry (E2EE_ENABLED=on)');
    await db.query('DELETE FROM mx_devices WHERE user_id = $1', [user]); // the probe above registered one
    const reg = await api('POST', '/devices', { userId: user, body: { publicKey: pubKey(), deviceName: 'verify-1' } });
    check(reg.status === 201 && reg.json?.data?.isPrimary === true, 'register first device -> 201, primary', JSON.stringify(reg.json));
    const dup = await api('POST', '/devices', { userId: user, body: { publicKey: pubKey() } });
    check(dup.status === 409 && dup.json?.error?.code === 'DEVICE_EXISTS', 'second registration -> 409 DEVICE_EXISTS');

    for (const bad of ['short', 'A'.repeat(44), '!'.repeat(43)]) {
      const r = await api('POST', '/devices', { userId: await newUser(), body: { publicKey: bad } });
      check(r.status === 400, `invalid publicKey rejected (${bad.slice(0, 8)}...) -> 400`);
    }
    check((await api('POST', '/devices', { body: { publicKey: pubKey() } })).status === 403, 'a token without a user cannot register -> 403');
    check((await api('POST', '/devices', { userId: randomUUID(), body: { publicKey: pubKey() } })).status === 404, 'unknown user -> 404');

    const racer = await newUser();
    const race = await Promise.all(Array.from({ length: 8 }, () => api('POST', '/devices', { userId: racer, body: { publicKey: pubKey() } })));
    check(race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409).length === 7, '8 simultaneous registrations -> exactly one wins');

    const list = await api('GET', `/devices?userIds=${user},${racer}`, { userId: user });
    check(list.status === 200 && list.json.data.length === 2, 'GET /devices lists both users');
    check(list.json?.data?.[0] && Object.keys(list.json.data[0]).sort().join() === 'deviceName,id,isPrimary,publicKey,userId', 'list items have exactly id, userId, publicKey, isPrimary, deviceName');
    check((await api('GET', '/devices?userIds=not-a-uuid', { userId: user })).status === 400, 'bad user id -> 400');
    check((await api('GET', `/devices?userIds=${Array.from({ length: 51 }, () => randomUUID()).join(',')}`, { userId: user })).status === 400, 'more than 50 ids -> 400');

    const owner = await newUser();
    const mk = async (primary) => (await db.query(
      `INSERT INTO mx_devices (project_id, user_id, public_key, is_primary) VALUES ($1,$2,$3,$4) RETURNING id`, [PROJECT, owner, pubKey(), primary])).rows[0].id;
    const d1 = await mk(true); const d2 = await mk(false); const d3 = await mk(false);
    check((await api('DELETE', `/devices/${d1}`, { userId: await newUser() })).status === 404, "someone else cannot revoke your device -> 404");
    const rev = await api('DELETE', `/devices/${d1}`, { userId: owner });
    check(rev.status === 200 && !!rev.json?.data?.revokedAt, 'revoke own primary device -> 200');
    const after = (await db.query('SELECT id, is_primary FROM mx_devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at, id', [owner])).rows;
    check(after.length === 2 && after[0].id === d2 && after[0].is_primary && !after[1].is_primary, 'the oldest remaining device became primary');
    check((await api('DELETE', `/devices/${d1}`, { userId: owner })).status === 404, 'revoking twice -> 404');
    const afterList = await api('GET', `/devices?userIds=${owner}`, { userId: owner });
    check(afterList.json?.data?.every((d) => d.id !== d1) && afterList.json.data.length === 2, 'revoked device no longer listed');
    void d3;

    // ---------------------------------------------------------------- Stage 7.3
    section('Stage 7.3: pairing, link, admin reset (key-bound approval)');
    const pu = await newUser();
    const primary = await api('POST', '/devices', { userId: pu, body: { publicKey: pubKey() }, headers: {} });
    const primaryId = primary.json?.data?.id;
    const newKey = pubKey();
    const asPrimary = { 'x-device-id': primaryId };

    const early = await api('POST', '/devices/link', { userId: pu, body: { publicKey: newKey } });
    check(early.status === 404 && early.json?.error?.code === 'PAIRING_NOT_FOUND', 'link before the primary approves -> 404 PAIRING_NOT_FOUND');
    const noHdr = await api('POST', '/devices/pair', { userId: pu, body: { publicKey: newKey } });
    check(noHdr.status === 403 && noHdr.json?.error?.code === 'DEVICE_REQUIRED', 'pair without X-Device-Id -> 403 DEVICE_REQUIRED');
    const badDev = await api('POST', '/devices/pair', { userId: pu, body: { publicKey: newKey }, headers: { 'x-device-id': randomUUID() } });
    check(badDev.status === 403 && badDev.json?.error?.code === 'DEVICE_INVALID', 'pair with an unknown device id -> 403 DEVICE_INVALID');
    const appr = await api('POST', '/devices/pair', { userId: pu, body: { publicKey: newKey }, headers: asPrimary });
    check(appr.status === 200 && !!appr.json?.data?.expiresAt, 'primary approves the new key -> 200 with expiresAt', JSON.stringify(appr.json));
    const wrongKey = await api('POST', '/devices/link', { userId: pu, body: { publicKey: pubKey() } });
    check(wrongKey.status === 404, 'a DIFFERENT key cannot use that approval -> 404');
    const stranger = await api('POST', '/devices/link', { userId: await newUser(), body: { publicKey: newKey } });
    check(stranger.status === 404, "another user cannot use that approval -> 404");
    const linked = await api('POST', '/devices/link', { userId: pu, body: { publicKey: newKey, deviceName: 'verify-phone' } });
    check(linked.status === 201 && linked.json?.data?.isPrimary === false && linked.json.data.devices?.length === 1 && linked.json.data.devices[0].id === primaryId, 'new device links -> 201, not primary, sees the primary in `devices`', JSON.stringify(linked.json));
    const replay = await api('POST', '/devices/link', { userId: pu, body: { publicKey: newKey } });
    check(replay.status === 404, 'the approval cannot be used twice -> 404');
    const byCompanion = await api('POST', '/devices/pair', { userId: pu, body: { publicKey: pubKey() }, headers: { 'x-device-id': linked.json?.data?.id } });
    check(byCompanion.status === 403, 'a companion device cannot approve more devices -> 403');
    const alive = await api('GET', `/devices?userIds=${pu}`, { userId: pu });
    check(alive.json?.data?.length === 2, 'the user now has 2 active devices');

    const byUser = await api('POST', `/users/${pu}/devices/reset`, { userId: pu });
    check(byUser.status === 403, "an end-user token cannot reset devices -> 403");
    const resetRes = await api('POST', `/users/${pu}/devices/reset`);
    check(resetRes.status === 200 && resetRes.json?.data?.revoked === 2, 'an API token resets: both devices revoked -> {revoked: 2}', JSON.stringify(resetRes.json));
    const gone = await api('GET', `/devices?userIds=${pu}`, { userId: pu });
    check(gone.json?.data?.length === 0, 'no active devices after reset');
    const fresh = await api('POST', '/devices', { userId: pu, body: { publicKey: pubKey() } });
    check(fresh.status === 201 && fresh.json?.data?.isPrimary === true, 'the user can register a fresh primary after a reset');

    // ---------------------------------------------------------------- Stage 7.4
    section('Stage 7.4: encrypted conversations and conversation keys');
    const mkUser = async () => {
      const id = await newUser();
      const r = await api('POST', '/devices', { userId: id, body: { publicKey: pubKey() } });
      return { id, device: r.json?.data?.id };
    };
    const ua = await mkUser();
    const ub = await mkUser();
    const noDeviceUser = await newUser();
    const wrapFor = (devs, by) => devs.map((d) => ({ deviceId: d, wrappedKey: wrapped(), wrappedByDeviceId: by }));
    const create = (body, who = ua, device = ua.device) => api('POST', '/conversations', { userId: who.id, headers: device ? { 'x-device-id': device } : {}, body });
    const baseBody = { type: 'group', title: 'verify-e2ee', participantIds: [ua.id, ub.id], encryptionMode: 'e2ee-v1' };

    const noHdr2 = await create({ ...baseBody, keys: wrapFor([ua.device, ub.device], ua.device) }, ua, null);
    check(noHdr2.status === 403 && noHdr2.json?.error?.code === 'DEVICE_REQUIRED', 'create without X-Device-Id -> 403 DEVICE_REQUIRED');
    const missing = await create({ ...baseBody, title: 'verify-e2ee-stale', keys: wrapFor([ua.device], ua.device) });
    check(missing.status === 409 && missing.json?.error?.code === 'STALE_DEVICE_SET' && missing.json.error.details?.deviceIds?.length === 2, 'keys missing one device -> 409 STALE_DEVICE_SET listing both devices');
    check((await db.query(`SELECT 1 FROM mx_conversations WHERE title = 'verify-e2ee-stale'`)).rows.length === 0, 'the failed create left no conversation behind (atomic)');
    const nodev = await create({ ...baseBody, participantIds: [ua.id, noDeviceUser], keys: wrapFor([ua.device], ua.device) });
    check(nodev.status === 409 && nodev.json?.error?.code === 'PARTICIPANT_HAS_NO_DEVICE', 'a participant without a device -> 409 PARTICIPANT_HAS_NO_DEVICE');
    const byOther = await create({ ...baseBody, keys: wrapFor([ua.device, ub.device], ub.device) });
    check(byOther.status === 400, 'wraps attributed to a different device -> 400');

    const made = await create({ ...baseBody, keys: wrapFor([ua.device, ub.device], ua.device) });
    check(made.status === 201 && made.json?.data?.encryption_mode === 'e2ee-v1' && made.json.data.min_key_version === 1, 'valid create -> 201 with encryption_mode "e2ee-v1"', JSON.stringify(made.json));
    const cid = made.json?.data?.id;
    const keyCount = (await db.query('SELECT count(*)::int AS n FROM mx_conversation_keys WHERE conversation_id = $1', [cid])).rows[0].n;
    check(keyCount === 2, 'one key row per device was stored');

    const myKeys = await api('GET', `/conversations/${cid}/keys`, { userId: ub.id, headers: { 'x-device-id': ub.device } });
    check(myKeys.status === 200 && myKeys.json.data.length === 1 && myKeys.json.data[0].keyVersion === 1 && !!myKeys.json.data[0].wrappedByPublicKey, "GET keys returns only my device's key, with the wrapper's public key");
    const outsider = await mkUser();
    check((await api('GET', `/conversations/${cid}/keys`, { userId: outsider.id, headers: { 'x-device-id': outsider.device } })).status === 403, 'a non-participant cannot read the keys -> 403');

    const ub2 = (await db.query(`INSERT INTO mx_devices (project_id, user_id, public_key) VALUES ($1,$2,$3) RETURNING id`, [PROJECT, ub.id, pubKey()])).rows[0].id;
    const up = await api('POST', `/conversations/${cid}/keys`, { userId: ua.id, headers: { 'x-device-id': ua.device }, body: { keyVersion: 1, keys: wrapFor([ub2], ua.device) } });
    check(up.status === 201 && up.json?.data?.inserted === 1, "wrap the key for B's new device -> 201");
    const dup2 = await api('POST', `/conversations/${cid}/keys`, { userId: ua.id, headers: { 'x-device-id': ua.device }, body: { keyVersion: 1, keys: wrapFor([ub2], ua.device) } });
    check(dup2.status === 409 && dup2.json?.error?.code === 'KEY_EXISTS', 'the same upload again -> 409 KEY_EXISTS (first writer wins)');
    const skip = await api('POST', `/conversations/${cid}/keys`, { userId: ua.id, headers: { 'x-device-id': ua.device }, body: { keyVersion: 3, keys: wrapFor([ua.device, ub.device, ub2], ua.device) } });
    check(skip.status === 400, 'skipping a key version -> 400');
    const partial = await api('POST', `/conversations/${cid}/keys`, { userId: ua.id, headers: { 'x-device-id': ua.device }, body: { keyVersion: 2, keys: wrapFor([ua.device, ub.device], ua.device) } });
    check(partial.status === 409 && partial.json?.error?.code === 'STALE_DEVICE_SET', 'a new key version that misses a device -> 409 STALE_DEVICE_SET');
    const rot = await api('POST', `/conversations/${cid}/keys`, { userId: ua.id, headers: { 'x-device-id': ua.device }, body: { keyVersion: 2, keys: wrapFor([ua.device, ub.device, ub2], ua.device) } });
    check(rot.status === 201 && rot.json?.data?.inserted === 3, 'a complete new key version (rotation) -> 201');
    const reqk = await api('POST', `/conversations/${cid}/keys/request`, { userId: ub.id, headers: { 'x-device-id': ub2 }, body: { keyVersion: 2 } });
    check(reqk.status === 202, 'a device asks for the key -> 202');

    const plain = await api('POST', '/conversations', { userId: ua.id, body: { type: 'group', participantIds: [ua.id] } });
    check(plain.status === 201 && plain.json?.data?.encryption_mode === 'none', 'a normal conversation is unchanged (encryption_mode "none")');
    convIds.push(cid, plain.json?.data?.id);
  }
} finally {
  const cs = convIds.filter(Boolean);
  if (cs.length) await db.query('DELETE FROM mx_conversations WHERE id = ANY($1::uuid[])', [cs]).catch(() => {});
  if (created.length) await db.query('DELETE FROM mx_users WHERE id = ANY($1::uuid[])', [created]).catch(() => {});
  await db.end().catch(() => {});
}

say(`\n${failed === 0 ? 'ALL GOOD' : 'FAILED'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
