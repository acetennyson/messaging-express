// Response-SHAPE baselines for the E2EE routes (Stage 7.9). Same idea as scripts/smoke.sh, for the routes smoke.sh
// does not cover; needs E2EE_ENABLED=on on the server. Works on Windows, macOS and Linux (Node only, no jq/bash).
// Each response is reduced to status + JSON keys + value TYPES (never values; ids, timestamps and keys are ignored)
// and diffed against scripts/baselines-e2ee/. Any added/removed/renamed field or changed type fails.
//
//   node scripts/smoke-e2ee.mjs --record     once, on a known-good build (E2EE_ENABLED=on)
//   node scripts/smoke-e2ee.mjs              compare; exit 1 on any difference
//
// DEV/STAGING ONLY: it creates users, devices, conversations, messages and a backup (the users are named smoke-e2ee-*).
// Env: BASE_URL [http://localhost:3000], JWT_SECRET (required), PROJECT_ID / ORGANIZATION_ID [seed].
// The ORIGINAL baselines (scripts/smoke.sh) must still pass with the flag off AND on; run both.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('export JWT_SECRET (same value the server uses)'); process.exit(2); }
if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE) && process.env.SMOKE_ALLOW_REMOTE !== '1') { console.error(`Refusing to run against ${BASE} (this writes data). Set SMOKE_ALLOW_REMOTE=1 to override.`); process.exit(2); }
const PROJECT = process.env.PROJECT_ID || '00000000-0000-4000-8000-0000000000a2';
const ORG = process.env.ORGANIZATION_ID || '00000000-0000-4000-8000-0000000000a1';
const RECORD = process.argv.includes('--record');
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'baselines-e2ee');
fs.mkdirSync(DIR, { recursive: true });

const tok = (userId) => jwt.sign({ projectId: PROJECT, organizationId: ORG, type: userId ? 'user' : 'api', ...(userId && { userId }) }, SECRET, { expiresIn: '1h' });
const b64 = (n) => randomBytes(n).toString('base64url');
const ct = () => Buffer.concat([Buffer.from([1]), randomBytes(59)]).toString('base64url');

// jq-equivalent shape (scripts/smoke.sh SHAPE_JQ): objects by sorted key, arrays unioned, scalars by type name.
const typeName = (v) => (v === null ? 'null' : typeof v);
function merge(shapes) {
  const nn = shapes.filter((s) => s !== 'null');
  if (nn.length === 0) return 'null';
  if (nn.every((s) => s && typeof s === 'object' && !Array.isArray(s))) {
    const keys = [...new Set(nn.flatMap((s) => Object.keys(s)))].sort();
    return Object.fromEntries(keys.map((k) => [k, merge(nn.filter((s) => k in s).map((s) => s[k]))]));
  }
  if (nn.every(Array.isArray)) { const els = nn.flat(); return els.length ? [merge(els)] : []; }
  return [...new Set(nn.map((s) => (typeof s === 'string' ? s : `<${typeof s}>`)))].sort().join('|');
}
function shape(v) {
  if (Array.isArray(v)) { const s = v.map(shape); return s.length ? [merge(s)] : []; }
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])]));
  return typeName(v);
}
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

let failed = 0, checked = 0;
async function step(name, method, p, { userId, device, body, form } = {}) {
  const res = await fetch(`${BASE}/api/v1${p}`, {
    method,
    headers: { origin: 'http://smoke.test', authorization: `Bearer ${tok(userId)}`, ...(form ? {} : { 'content-type': 'application/json' }), ...(device ? { 'x-device-id': device } : {}) },
    ...(form ? { body: form } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  const out = sortKeys({ status: res.status, contentType: (res.headers.get('content-type') || '').toLowerCase(), accessControlAllowOrigin: res.headers.get('access-control-allow-origin') || '', body: json === null ? (text ? 'non-json' : 'empty') : shape(json) });
  const file = path.join(DIR, `${name}.json`);
  const rendered = JSON.stringify(out, null, 2) + '\n';
  checked += 1;
  if (RECORD) { fs.writeFileSync(file, rendered); console.log(`  REC   ${name.padEnd(30)} ${method} ${p.split('?')[0].replace(/[0-9a-f-]{36}/g, ':id')} -> ${res.status}`); }
  else if (!fs.existsSync(file)) { console.log(`  FAIL  ${name.padEnd(30)} no baseline (run with --record on a known-good build)`); failed = 1; }
  else if (fs.readFileSync(file, 'utf8').replace(/\r/g, '') === rendered) console.log(`  PASS  ${name.padEnd(30)} ${method} -> ${res.status}`);
  else { console.log(`  FAIL  ${name.padEnd(30)} ${method} -> ${res.status}\n        expected: ${fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ')}\n        actual:   ${rendered.replace(/\s+/g, ' ')}`); failed = 1; }
  return { status: res.status, json };
}

console.log(`E2EE smoke (${RECORD ? 'record' : 'compare'}) against ${BASE}`);
const mkUser = async (label) => {
  const u = await (await fetch(`${BASE}/api/v1/users`, { method: 'POST', headers: { authorization: `Bearer ${tok()}`, 'content-type': 'application/json' }, body: JSON.stringify({ externalId: `smoke-e2ee-${label}-${Date.now()}-${b64(3)}`, name: `smoke-e2ee-${label}` }) })).json();
  return u.data.id;
};
const [A, B, C] = [await mkUser('a'), await mkUser('b'), await mkUser('c')];
const probe = await fetch(`${BASE}/api/v1/devices`, { method: 'GET', headers: { authorization: `Bearer ${tok(A)}` } });
if (probe.status === 404) { console.error('The E2EE routes answer 404: start the server with E2EE_ENABLED=on.'); process.exit(2); }

// devices
const regA = await step('01-devices-register', 'POST', '/devices', { userId: A, body: { publicKey: b64(32), deviceName: 'smoke' } });
const dA = regA.json?.data?.id;
const dB = (await step('02-devices-register-b', 'POST', '/devices', { userId: B, body: { publicKey: b64(32) } })).json?.data?.id;
await step('03-devices-register-again', 'POST', '/devices', { userId: A, body: { publicKey: b64(32) } });
await step('04-devices-list', 'GET', `/devices?userIds=${A},${B}`, { userId: A });
const newKey = b64(32);
await step('05-devices-pair', 'POST', '/devices/pair', { userId: A, device: dA, body: { publicKey: newKey } });
const link = await step('06-devices-link', 'POST', '/devices/link', { userId: A, body: { publicKey: newKey } });
await step('07-devices-link-again', 'POST', '/devices/link', { userId: A, body: { publicKey: newKey } });
await step('08-devices-revoke', 'DELETE', `/devices/${link.json?.data?.id}`, { userId: A, device: dA });
await step('09-devices-reset-forbidden', 'POST', `/users/${A}/devices/reset`, { userId: A });

// conversations and keys
const wrap = (devs, by) => devs.map((d) => ({ deviceId: d, wrappedKey: b64(73), wrappedByDeviceId: by }));
await step('10-conversation-stale-keys', 'POST', '/conversations', { userId: A, device: dA, body: { type: 'group', title: 'smoke-e2ee', participantIds: [A, B], encryptionMode: 'e2ee-v1', keys: wrap([dA], dA) } });
const conv = await step('11-conversation-create', 'POST', '/conversations', { userId: A, device: dA, body: { type: 'group', title: 'smoke-e2ee', participantIds: [A, B], encryptionMode: 'e2ee-v1', keys: wrap([dA, dB], dA) } });
const cid = conv.json?.data?.id;
await step('12-keys-get', 'GET', `/conversations/${cid}/keys`, { userId: B, device: dB });
await step('13-keys-exists', 'POST', `/conversations/${cid}/keys`, { userId: A, device: dA, body: { keyVersion: 1, keys: wrap([dA], dA) } });
await step('14-keys-request', 'POST', `/conversations/${cid}/keys/request`, { userId: B, device: dB, body: {} });

// messages
await step('20-message-ciphertext', 'POST', '/messages', { userId: A, body: { conversationId: cid, senderId: A, content: ct(), metadata: { scheme: 'ck-xchacha-v1', key_version: 1 } } });
await step('21-message-plaintext', 'POST', '/messages', { userId: A, body: { conversationId: cid, senderId: A, content: 'plain', metadata: undefined } });
await step('22-messages-get', 'GET', `/messages?conversationId=${cid}&limit=5`, { userId: A });

// participants and rotation
const dC = (await step('30-devices-register-c', 'POST', '/devices', { userId: C, body: { publicKey: b64(32) } })).json?.data?.id;
await step('31-participant-add', 'POST', `/conversations/${cid}/participants`, { userId: A, body: { userId: C } });
await step('32-participant-add-again', 'POST', `/conversations/${cid}/participants`, { userId: A, body: { userId: C } });
await step('33-participant-remove', 'DELETE', `/conversations/${cid}/participants/${C}`, { userId: A });
await step('34-participant-remove-again', 'DELETE', `/conversations/${cid}/participants/${C}`, { userId: A });
await step('35-message-old-key-version', 'POST', '/messages', { userId: A, body: { conversationId: cid, senderId: A, content: ct(), metadata: { scheme: 'ck-xchacha-v1', key_version: 1 } } });
await step('36-keys-next-version', 'POST', `/conversations/${cid}/keys`, { userId: A, device: dA, body: { keyVersion: 2, keys: wrap([dA, dB], dA) } });
void dC;

// backup and uploads
const kdf = { v: 1, alg: 'argon2id', m: 19456, t: 2, p: 1, salt: b64(16) };
await step('40-backup-get-empty', 'GET', '/devices/backup', { userId: A });
await step('41-backup-put', 'PUT', '/devices/backup', { userId: A, body: { blob: b64(300), kdf } });
await step('42-backup-get', 'GET', '/devices/backup', { userId: A });
await step('43-backup-bad-kdf', 'PUT', '/devices/backup', { userId: A, body: { blob: b64(300), kdf: { ...kdf, extra: 1 } } });
await step('44-backup-delete', 'DELETE', '/devices/backup', { userId: A });
const upload = (cat) => { const f = new FormData(); f.append('file', new Blob([randomBytes(128)], { type: 'application/octet-stream' }), 'smoke.bin'); if (cat) f.append('category', cat); return f; };
await step('50-upload-e2ee', 'POST', '/uploads', { userId: A, form: upload('e2ee') });
await step('51-upload-no-category', 'POST', '/uploads', { userId: A, form: upload(undefined) });

console.log(`\n${RECORD ? `Recorded ${checked} baselines in scripts/baselines-e2ee/` : failed ? 'E2EE SMOKE FAILED' : `E2EE SMOKE PASSED (${checked} checks)`}`);
process.exit(failed);
