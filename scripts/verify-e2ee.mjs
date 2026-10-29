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
  const existing = await db.query(`SELECT count(*)::int AS n FROM mx_conversations WHERE encryption_mode <> 'none' OR min_key_version <> 1`);
  check(existing.rows[0].n === 0, 'existing conversations still read none / 1');

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
  }
} finally {
  if (created.length) await db.query('DELETE FROM mx_users WHERE id = ANY($1::uuid[])', [created]).catch(() => {});
  await db.end().catch(() => {});
}

say(`\n${failed === 0 ? 'ALL GOOD' : 'FAILED'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
