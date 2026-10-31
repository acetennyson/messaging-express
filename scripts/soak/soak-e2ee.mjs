// E2EE soak: drives a RUNNING server (E2EE_ENABLED=on) with a continuous mix of encrypted-conversation traffic and
// CHECKS THE RULES while doing it. It is a protocol soak, not a crypto one: it uses synthetic keys and ciphertext
// (the server cannot tell the difference), so it needs no client-crypto. It complements scripts/soak/soak.mjs.
//
//   JWT_SECRET=... node scripts/soak/soak-e2ee.mjs                    # 60 s smoke run
//   JWT_SECRET=... DURATION_S=0 OUT=soak-e2ee.jsonl node scripts/soak/soak-e2ee.mjs   # forever (Ctrl+C or SIGTERM to stop)
//
// Env (defaults in brackets):
//   BASE_URL [http://localhost:3000]   JWT_SECRET (required, same as the server)   PROJECT_ID / ORGANIZATION_ID [seed]
//   DURATION_S [60]      0 = run until stopped
//   GROUPS [3]           independent encrypted conversations of 3 users each; scenarios run concurrently across groups
//   OPS_PER_SEC [2]      scenarios started per second, in total
//   EVENT_WAIT_MS [10000] how long a realtime event may take before it counts as missed
//   FAIL_FAST [off]      on = exit 1 at the first broken rule
//   OUTAGE_ABORT_S [300] server unreachable for this long = stop with exit 3 (0 = wait forever)
//   HEALTH_PATH [/api/health]  probed every 2 s; ANY http response counts as "up", only a refused/reset/timed-out request is "down"
//   OUT [soak-e2ee-<ts>.jsonl]  one JSON line per 10 s window, then a final {summary:true} line
//
// What it asserts (a "violation" is any of these failing):
//   - a valid ciphertext at the latest key version is accepted; plaintext is refused (400)
//   - after removing a member, the old key version is refused (409 KEY_ROTATION_REQUIRED) and the next version
//     can only be uploaded for the remaining devices; a re-added member can be wrapped the current key
//   - every device.added/removed, keys.updated/requested and participant.added/removed event reaches exactly the
//     users it should (missed and duplicate/unexpected events are counted), and a user who shares no conversation
//     hears nothing
//   - key backup round-trips byte-exact; an encrypted-attachment upload is accepted only with category=e2ee
//
// Outages: if the server stops answering, that is NOT a rule violation. Operations pause, the events and groups in
// flight at that moment are voided (counted as `voided`, never as missed), the groups are rebuilt when the server is
// back, and the outage is recorded in the summary. Exit codes: 0 clean, 1 a rule broke, 2 setup failed, 3 gave up
// waiting for the server.
//
// DEV/STAGING ONLY: it creates users, devices, conversations and messages (named soak-e2ee-*), and leaves them.
// The .uploads/ directory grows slowly (small blobs). Delete the soak-e2ee-* users to clean up.
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import { randomBytes } from 'node:crypto';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('export JWT_SECRET (same value the server uses)'); process.exit(2); }
const PROJECT = process.env.PROJECT_ID || '00000000-0000-4000-8000-0000000000a2';
const ORG = process.env.ORGANIZATION_ID || '00000000-0000-4000-8000-0000000000a1';
const DURATION_S = Number(process.env.DURATION_S ?? 60);
const GROUPS = Math.max(1, Number(process.env.GROUPS || 3));
const OPS = Math.max(0.1, Number(process.env.OPS_PER_SEC || 2));
const EVENT_WAIT_MS = Number(process.env.EVENT_WAIT_MS || 10_000);
const FAIL_FAST = (process.env.FAIL_FAST || 'off') === 'on';
const OUTAGE_ABORT_S = Number(process.env.OUTAGE_ABORT_S ?? 300);
const HEALTH_PATH = process.env.HEALTH_PATH || '/api/health';
const OUT = process.env.OUT || `soak-e2ee-${Date.now()}.jsonl`;
const out = fs.createWriteStream(OUT, { flags: 'a' });

const tok = (userId) => jwt.sign({ projectId: PROJECT, organizationId: ORG, type: userId ? 'user' : 'api', ...(userId && { userId }) }, SECRET, { expiresIn: '12h' });
const b64 = (n) => randomBytes(n).toString('base64url');
const pk = () => b64(32);
const wk = () => b64(73);
const ct = () => Buffer.concat([Buffer.from([1]), randomBytes(59)]).toString('base64url');
const meta = (v) => ({ scheme: 'ck-xchacha-v1', key_version: v });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const pct = (arr, p) => (arr.length ? [...arr].sort((x, y) => x - y)[Math.min(arr.length - 1, Math.ceil((p / 100) * arr.length) - 1)] : null);

// ------------------------------------------------------------------ accounting
let win = { ops: {}, lat: {}, statusErrors: 0 };
const total = { ops: 0, violations: 0, statusErrors: 0, expected: 0, matched: 0, missed: 0, unexpected: 0, transportErrors: 0, voided: 0, outages: 0, outageSeconds: 0 };
const outageLog = [];
class TransportError extends Error {}
const problems = [];
function violation(msg) {
  total.violations += 1;
  if (problems.length < 50) problems.push({ t: new Date().toISOString(), msg });
  console.error(`VIOLATION: ${msg}`);
  if (FAIL_FAST) finish(1);
}
const expectStatus = (label, r, ...ok) => {
  if (!ok.includes(r.status)) { total.statusErrors += 1; win.statusErrors += 1; violation(`${label}: expected ${ok.join('/')} got ${r.status} ${JSON.stringify(r.body?.error ?? r.body).slice(0, 200)}`); return false; }
  return true;
};
async function api(group, method, path, { userId, device, body } = {}) {
  const t0 = performance.now();
  let status = 0, json = {};
  try {
    const r = await fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${tok(userId)}`, 'content-type': 'application/json', ...(device ? { 'x-device-id': device } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    status = r.status;
    json = await r.json().catch(() => ({}));
  } catch (e) { throw new TransportError(`${method} ${path}: ${e?.cause?.code || e?.message || e}`); }
  const ms = performance.now() - t0;
  (win.lat[group] ||= []).push(ms);
  return { status, body: json, ms };
}

// ------------------------------------------------------------------ realtime expectations
const seen = new Map(); // key -> [timestamps]
const pending = []; // { key, deadline, label }
const sockets = [];
const strangerEvents = [];
function onEvent(userId, name, data) {
  const disc = { 'device.added': data.deviceId, 'device.removed': data.deviceId, 'keys.updated': `${data.conversationId}:${data.keyVersion}`, 'keys.requested': `${data.conversationId}:${data.requestingDeviceId}:${data.keyVersion ?? ''}`, 'participant.added': `${data.conversationId}:${data.userId}`, 'participant.removed': `${data.conversationId}:${data.userId}` }[name];
  if (userId === stranger?.id) { strangerEvents.push(name); violation(`stranger received ${name}`); return; }
  const key = `${userId}|${name}|${disc}`;
  (seen.get(key) || seen.set(key, []).get(key)).push(Date.now());
}
function expectEvent(userIds, name, disc) {
  for (const u of userIds) { pending.push({ key: `${u}|${name}|${disc}`, deadline: Date.now() + EVENT_WAIT_MS, label: `${name} -> ${u}` }); total.expected += 1; }
}
// Server not answering (or just stopped answering): expectations cannot be judged, drop them instead of failing them.
function voidPending() { total.voided += pending.length; total.expected -= pending.length; pending.length = 0; seen.clear(); }
function reconcile(final = false) {
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i];
    const hits = seen.get(p.key);
    if (hits?.length) { hits.shift(); if (!hits.length) seen.delete(p.key); pending.splice(i, 1); total.matched += 1; }
    else if (suspect || down) continue;
    else if (Date.now() > p.deadline || final) { pending.splice(i, 1); total.missed += 1; violation(`missed event: ${p.label}`); }
  }
}
function sweepUnexpected(final = false) {
  if (suspect || down) return;
  const cutoff = Date.now() - EVENT_WAIT_MS * 2;
  for (const [key, ts] of [...seen]) {
    const old = ts.filter((t) => final || t < cutoff);
    if (old.length) { total.unexpected += old.length; violation(`unexpected or duplicate event: ${key} x${old.length}`); const rest = ts.filter((t) => !old.includes(t)); rest.length ? seen.set(key, rest) : seen.delete(key); }
  }
}
function listen(userId) {
  const s = io(BASE, { auth: (cb) => cb({ token: tok(userId) }), transports: ['websocket'], reconnection: true });
  for (const n of ['device.added', 'device.removed', 'keys.updated', 'keys.requested', 'participant.added', 'participant.removed']) s.on(n, (d) => onEvent(userId, n, d));
  sockets.push(s);
  socketOf.set(userId, s);
  return new Promise((res) => { s.once('connect', () => setTimeout(res, 200)); s.once('connect_error', () => res()); });
}

// ------------------------------------------------------------------ fixtures
class SetupError extends Error {}
let stranger = null;
let groups = [];
let gseq = 0;
const socketOf = new Map(); // userId -> socket
async function mkUser(label) {
  const r = await api('setup', 'POST', '/users', { body: { externalId: `soak-e2ee-${label}-${Date.now()}-${b64(3)}`, name: `soak-e2ee-${label}` } });
  if (!r.body?.data?.id) throw new SetupError(`cannot create users: ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.data.id;
  const d = await api('setup', 'POST', '/devices', { userId: id, body: { publicKey: pk() } });
  if (!d.body?.data?.id) throw new SetupError(`cannot register a device (is E2EE_ENABLED=on on the server?): ${d.status} ${JSON.stringify(d.body)}`);
  return { id, device: d.body.data.id };
}
async function buildGroup() {
  const g = gseq++;
  const users = [await mkUser(`g${g}a`), await mkUser(`g${g}b`), await mkUser(`g${g}c`)];
  const c = await api('setup', 'POST', '/conversations', {
    userId: users[0].id, device: users[0].device,
    body: { type: 'group', title: `soak-e2ee-g${g}`, participantIds: users.map((u) => u.id), encryptionMode: 'e2ee-v1', keys: users.map((u) => ({ deviceId: u.device, wrappedKey: wk(), wrappedByDeviceId: users[0].device })) },
  });
  if (c.status !== 201) throw new SetupError(`cannot create the encrypted conversation: ${c.status} ${JSON.stringify(c.body)}`);
  for (const u of users) await listen(u.id);
  return { n: g, users, members: new Set(users.map((u) => u.id)), conv: c.body.data.id, latest: 1, min: 1, busy: false, dead: false };
}
async function setup() {
  stranger = await mkUser('stranger');
  await listen(stranger.id);
  for (let i = 0; i < GROUPS; i++) groups.push(await buildGroup());
}
function retire(g) { g.dead = true; for (const u of g.users) { socketOf.get(u.id)?.close(); socketOf.delete(u.id); } }

// ------------------------------------------------------------------ scenarios (each leaves the group in a consistent state)
const memberUsers = (g) => g.users.filter((u) => g.members.has(u.id));
const upload = (g, caller, version, devices) => api('keys', 'POST', `/conversations/${g.conv}/keys`, { userId: caller.id, device: caller.device, body: { keyVersion: version, keys: devices.map((d) => ({ deviceId: d, wrappedKey: wk(), wrappedByDeviceId: caller.device })) } });
const send = (g, u, v, over = {}) => api('messages', 'POST', '/messages', { userId: u.id, body: { conversationId: g.conv, senderId: u.id, content: ct(), metadata: meta(v), ...over } });

const scenarios = {
  async send(g) {
    const r = await send(g, pick(memberUsers(g)), g.latest);
    expectStatus('send at latest key version', r, 201);
  },
  async plaintext(g) {
    const r = await send(g, pick(memberUsers(g)), g.latest, { content: 'plaintext by mistake', metadata: undefined });
    expectStatus('plaintext into encrypted conversation', r, 400);
  },
  async rotate(g) {
    const owner = g.users[0];
    const victim = pick(g.users.slice(1).filter((u) => g.members.has(u.id)));
    if (!victim) return;
    const everyone = memberUsers(g).map((u) => u.id);
    expectEvent(everyone, 'participant.removed', `${g.conv}:${victim.id}`);
    const rm = await api('participants', 'DELETE', `/conversations/${g.conv}/participants/${victim.id}`, { userId: owner.id });
    if (!expectStatus('remove participant', rm, 200)) return;
    g.members.delete(victim.id);
    g.min = g.latest + 1;
    if (rm.body.data?.minKeyVersion !== g.min) violation(`removal returned minKeyVersion ${rm.body.data?.minKeyVersion}, expected ${g.min}`);
    const stale = await send(g, owner, g.latest);
    if (stale.status !== 409 || stale.body?.error?.code !== 'KEY_ROTATION_REQUIRED') violation(`old key version after removal: expected 409 KEY_ROTATION_REQUIRED, got ${stale.status} ${stale.body?.error?.code}`);
    const remaining = memberUsers(g);
    const withVictim = await upload(g, owner, g.latest + 1, [...remaining.map((u) => u.device), victim.device]);
    if (withVictim.status !== 409 || withVictim.body?.error?.code !== 'STALE_DEVICE_SET') violation(`next key version including the removed user's device: expected 409 STALE_DEVICE_SET, got ${withVictim.status}`);
    expectEvent(remaining.map((u) => u.id), 'keys.updated', `${g.conv}:${g.latest + 1}`);
    if (!expectStatus('upload next key version', await upload(g, owner, g.latest + 1, remaining.map((u) => u.device)), 201)) return;
    g.latest += 1;
    expectStatus('send under the new version', await send(g, owner, g.latest), 201);
    // add the member back and give them the current key
    expectEvent([...remaining.map((u) => u.id), victim.id], 'participant.added', `${g.conv}:${victim.id}`);
    if (!expectStatus('re-add participant', await api('participants', 'POST', `/conversations/${g.conv}/participants`, { userId: owner.id, body: { userId: victim.id } }), 201)) return;
    g.members.add(victim.id);
    expectEvent([victim.id], 'keys.updated', `${g.conv}:${g.latest}`);
    expectStatus('wrap the current key for the re-added member', await upload(g, owner, g.latest, [victim.device]), 201);
    expectStatus('re-added member can send', await send(g, victim, g.latest), 201);
  },
  async linkCycle(g) {
    const x = pick(memberUsers(g));
    const everyone = memberUsers(g).map((u) => u.id);
    const key = pk();
    if (!expectStatus('pair', await api('devices', 'POST', '/devices/pair', { userId: x.id, device: x.device, body: { publicKey: key } }), 200)) return;
    const link = await api('devices', 'POST', '/devices/link', { userId: x.id, body: { publicKey: key } });
    if (!expectStatus('link', link, 201)) return;
    const nd = link.body.data.id;
    expectEvent(everyone, 'device.added', nd);
    expectEvent([x.id], 'keys.updated', `${g.conv}:${g.latest}`);
    expectStatus('wrap the current key for the new device', await upload(g, x, g.latest, [nd]), 201);
    expectEvent(everyone, 'device.removed', nd);
    expectStatus('revoke the new device', await api('devices', 'DELETE', `/devices/${nd}`, { userId: x.id, device: x.device }), 200);
  },
  async keyRequest(g) {
    const x = pick(memberUsers(g));
    expectEvent(memberUsers(g).filter((u) => u.id !== x.id).map((u) => u.id), 'keys.requested', `${g.conv}:${x.device}:`);
    expectStatus('key request', await api('keys', 'POST', `/conversations/${g.conv}/keys/request`, { userId: x.id, device: x.device, body: {} }), 202);
  },
  async backup(g) {
    const u = pick(g.users);
    const blob = b64(200 + Math.floor(Math.random() * 400));
    const kdf = { v: 1, alg: 'argon2id', m: 19456, t: 2, p: 1, salt: b64(16) };
    if (!expectStatus('backup put', await api('backup', 'PUT', '/devices/backup', { userId: u.id, body: { blob, kdf } }), 200)) return;
    const got = await api('backup', 'GET', '/devices/backup', { userId: u.id });
    if (got.status !== 200 || got.body.data?.blob !== blob || !Object.keys(kdf).every((k) => got.body.data?.kdf?.[k] === kdf[k])) violation(`backup did not round-trip byte-exact (status ${got.status})`);
    expectStatus('backup delete', await api('backup', 'DELETE', '/devices/backup', { userId: u.id }), 200);
  },
  async upload(g) {
    for (const [cat, shouldPass] of [['e2ee', true], [undefined, false]]) {
      const form = new FormData();
      form.append('file', new Blob([randomBytes(256)], { type: 'application/octet-stream' }), 'soak.bin');
      if (cat) form.append('category', cat);
      const t0 = performance.now();
      const r = await fetch(`${BASE}/api/v1/uploads`, { method: 'POST', headers: { authorization: `Bearer ${tok(g.users[0].id)}` }, body: form }).catch((e) => { throw new TransportError(`upload: ${e?.cause?.code || e?.message}`); });
      (win.lat.uploads ||= []).push(performance.now() - t0);
      const item = (await r.json().catch(() => ({})))?.data?.[0];
      if (shouldPass && (r.status !== 200 || item?.error)) violation(`octet-stream upload with category=e2ee was refused: ${r.status} ${item?.error}`);
      if (!shouldPass && !item?.error) violation('octet-stream upload WITHOUT category=e2ee was accepted');
    }
  },
};
const WEIGHTS = [['send', 40], ['plaintext', 5], ['rotate', 8], ['linkCycle', 8], ['keyRequest', 10], ['backup', 6], ['upload', 3]];
const weighted = () => { let r = Math.random() * WEIGHTS.reduce((a, [, w]) => a + w, 0); for (const [n, w] of WEIGHTS) if ((r -= w) < 0) return n; return 'send'; };

async function runOne() {
  if (down || suspect || rebuilding) return;
  const free = groups.filter((g) => !g.busy && !g.dead);
  if (!free.length) return;
  const g = pick(free);
  g.busy = true;
  const name = weighted();
  total.ops += 1;
  win.ops[name] = (win.ops[name] || 0) + 1;
  try { await scenarios[name](g); }
  catch (e) {
    if (e instanceof TransportError) { total.transportErrors += 1; g.dead = true; suspect = true; console.error(`transport error (not a violation): ${e.message}`); }
    else violation(`scenario ${name} threw: ${e?.message || e}`);
  }
  finally { g.busy = false; }
}

// ------------------------------------------------------------------ outage detection
let suspect = false, down = false, downSince = 0, fails = 0, probing = false, rebuilding = false, gaveUp = false;
async function isUp() {
  try { const r = await fetch(`${BASE}${HEALTH_PATH}`, { signal: AbortSignal.timeout(5000) }); await r.arrayBuffer().catch(() => {}); return true; }
  catch { return false; }
}
async function healthTick() {
  if (probing || stopped) return;
  probing = true;
  try {
    const up = await isUp();
    if (!up) {
      fails += 1; suspect = true;
      if (fails >= 2 && !down) { down = true; downSince = Date.now(); total.outages += 1; console.error(`SERVER UNREACHABLE since ${new Date(downSince).toISOString()} (operations paused, not counted as violations)`); }
      if (down && OUTAGE_ABORT_S > 0 && Date.now() - downSince > OUTAGE_ABORT_S * 1000) { gaveUp = true; finish(3); }
      return;
    }
    fails = 0;
    let recovered = false;
    if (down) {
      const secs = Math.round((Date.now() - downSince) / 1000);
      total.outageSeconds += secs; outageLog.push({ start: new Date(downSince).toISOString(), seconds: secs });
      console.error(`server is back after ${secs} s; rebuilding groups`);
      down = false; recovered = true;
    }
    if (suspect || groups.some((g) => g.dead)) {
      rebuilding = true;
      try {
        voidPending();
        const fresh = [];
        for (const g of groups) { if (g.dead || recovered || suspect) retire(g); }
        const keep = groups.filter((g) => !g.dead);
        for (let i = keep.length; i < GROUPS; i++) fresh.push(await buildGroup());
        groups = [...keep, ...fresh];
        suspect = false;
      } catch (e) {
        if (e instanceof TransportError) { fails = 1; console.error(`rebuild interrupted: ${e.message}`); }
        else { console.error(`rebuild failed: ${e.message}`); fails = 1; }
      } finally { rebuilding = false; }
    }
  } finally { probing = false; }
}

// ------------------------------------------------------------------ main loop
let startedAt = Date.now();
let stopped = false;
function windowLine() {
  const lat = Object.fromEntries(Object.entries(win.lat).map(([k, a]) => [k, { n: a.length, p50: pct(a, 50), p95: pct(a, 95), max: pct(a, 100) }]));
  out.write(JSON.stringify({ t: new Date().toISOString(), ops: win.ops, statusErrors: win.statusErrors, down, lat, totals: { ...total, pendingEvents: pending.length } }) + '\n');
  win = { ops: {}, lat: {}, statusErrors: 0 };
}
function finish(code) {
  if (stopped) return;
  stopped = true;
  clearInterval(healthTimer);
  if (down) { const secs = Math.round((Date.now() - downSince) / 1000); total.outageSeconds += secs; outageLog.push({ start: new Date(downSince).toISOString(), seconds: secs, ongoing: true }); }
  if (down || suspect) voidPending(); else { reconcile(true); sweepUnexpected(true); }
  windowLine();
  const summary = { summary: true, seconds: Math.round((Date.now() - startedAt) / 1000), groups: GROUPS, ...total, outageLog, gaveUp, firstProblems: problems };
  out.write(JSON.stringify(summary) + '\n', () => {
    for (const s of sockets) s.close();
    if (total.ops === 0) { total.violations += 1; console.error('VIOLATION: no operations ran'); }
    const bad = total.violations > 0;
    const o = total.outages ? `, ${total.outages} outage(s) totalling ${total.outageSeconds} s (${total.voided} events voided, not judged)` : '';
    console.log(`\n${gaveUp ? 'ABORTED (server unreachable)' : bad ? 'FAILED' : 'CLEAN'}: ${total.ops} operations, events ${total.matched}/${total.expected} delivered, ${total.missed} missed, ${total.unexpected} unexpected, ${total.violations} violations${o} (details in ${OUT})`);
    process.exit(bad && code === undefined ? 1 : (code ?? 0));
  });
}
process.on('SIGINT', () => finish());
process.on('SIGTERM', () => finish());

try { await setup(); }
catch (e) { console.error(e instanceof TransportError ? `server unreachable during setup: ${e.message}` : e.message); process.exit(e instanceof TransportError ? 3 : 2); }
startedAt = Date.now(); // the run time starts after setup, which can be slow when sockets cannot connect
console.log(`soak-e2ee running against ${BASE}: ${GROUPS} groups, ${OPS} ops/s, ${DURATION_S === 0 ? 'until stopped' : DURATION_S + ' s'}; output ${OUT}`);
const winTimer = setInterval(() => { reconcile(); sweepUnexpected(); windowLine(); }, 10_000);
const recTimer = setInterval(() => reconcile(), 1000);
const healthTimer = setInterval(() => void healthTick(), 2000);
const interval = 1000 / OPS;
let next = Date.now();
while (!stopped && (DURATION_S === 0 || Date.now() - startedAt < DURATION_S * 1000)) {
  runOne();
  next += interval;
  await sleep(Math.max(0, next - Date.now()));
}
clearInterval(winTimer); clearInterval(recTimer);
await sleep(Math.min(EVENT_WAIT_MS, 3000)); // let in-flight scenarios and events land
while (groups.some((g) => g.busy) && !stopped) await sleep(200);
await sleep(Math.min(EVENT_WAIT_MS, 3000));
finish();
