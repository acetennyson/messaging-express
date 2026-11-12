#!/usr/bin/env node
/**
 * Golden HTTP test: freezes what the server does today, so a refactor can prove it changed nothing.
 *
 * It drives every REST route with the full token matrix (no token, bad token, expired token, api, admin,
 * a user who is a member, a user who is not) and records, for each call, the status, a few headers and the
 * normalised response BODY WITH VALUES. This is stricter than scripts/smoke.sh, which compares shapes only
 * and uses one token. Ids, timestamps and the run id are replaced by stable placeholders, so two runs
 * against the same code give the same file.
 *
 *   node scripts/golden-http.mjs --record      write scripts/baselines-golden/<label>.json (known-good build only)
 *   node scripts/golden-http.mjs               compare with the baseline; exit 1 and print every difference
 *   node scripts/golden-http.mjs --print       print the normalised result and exit (used to test reproducibility)
 *
 * Run it once per server configuration you care about, with a different label each time:
 *   GOLDEN_LABEL=access-off      (PARTICIPANT_ACCESS_MODE=off, E2EE_ENABLED=off)
 *   GOLDEN_LABEL=access-enforce  (PARTICIPANT_ACCESS_MODE=enforce, E2EE_ENABLED=on)
 *
 * Setup (dev/staging only: it WRITES users, conversations, messages and uploads a file):
 *   psql "$DATABASE_URL" -f scripts/smoke-seed.sql      # only the org + project rows are used
 *   JWT_SECRET=... node scripts/golden-http.mjs --record
 *
 * Env: BASE_URL (default http://localhost:3000), JWT_SECRET (required), PROJECT_ID, ORGANIZATION_ID
 * (default: the smoke seed), GOLDEN_LABEL (default "default"), CRON_SECRET (to exercise the retry route
 * with the right secret; optional), GOLDEN_ALLOW_REMOTE=1 to allow a non-localhost BASE_URL.
 * Rate limiting must be off or dry-run on the server under test (a 429 aborts the run).
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const HERE = dirname(fileURLToPath(import.meta.url));

const ORIGIN = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const API = ORIGIN + '/api/v1';
const SECRET = process.env.JWT_SECRET;
const PROJECT_ID = process.env.PROJECT_ID || '00000000-0000-4000-8000-0000000000a2';
const ORG_ID = process.env.ORGANIZATION_ID || '00000000-0000-4000-8000-0000000000a1';
const LABEL = process.env.GOLDEN_LABEL || 'default';
const BASELINE = join(HERE, 'baselines-golden', `${LABEL}.json`);
const MODE = process.argv.includes('--record') ? 'record' : process.argv.includes('--print') ? 'print' : 'compare';

if (!SECRET) { console.error('JWT_SECRET is required'); process.exit(2); }
if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(ORIGIN) && process.env.GOLDEN_ALLOW_REMOTE !== '1') {
  console.error(`Refusing to run against ${ORIGIN} (this script writes data). Set GOLDEN_ALLOW_REMOTE=1 to override.`);
  process.exit(2);
}

const RUN = randomBytes(4).toString('hex'); // unique per run so repeated runs never collide; normalised away
const sign = (type, userId, opts = { expiresIn: '1h' }) =>
  jwt.sign({ projectId: PROJECT_ID, organizationId: ORG_ID, type, ...(userId && { userId }) }, SECRET, opts);

// ---------------------------------------------------------------- normalisation
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const ids = new Map();
const idOf = (u) => { const k = u.toLowerCase(); if (!ids.has(k)) ids.set(k, `<id:${ids.size + 1}>`); return ids.get(k); };
const VOLATILE_KEYS = new Set(['duration', 'timestamp', 'total', 'totalPages', 'exp', 'iat']);
function norm(v, key) {
  if (typeof v === 'string') {
    return v.replace(new RegExp(RUN, 'g'), '<run>').replace(UUID, idOf).replace(TS, '<ts>')
      .replace(/https?:\/\/[^/\s"]+\/uploads\//g, '<origin>/uploads/');
  }
  if (typeof v === 'number' && VOLATILE_KEYS.has(key)) return '<n>';
  if (Array.isArray(v)) return v.map((x) => norm(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x, k)]));
  return v;
}

// ---------------------------------------------------------------- calling
const results = [];
let aborted = false;
async function call(name, method, path, { token, body, form, headers = {}, base = API, raw } = {}) {
  const h = { origin: 'http://golden.test', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  let res, text;
  try { res = await fetch(base + path, { method, headers: h, body: payload }); text = await res.text(); }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exit(2); }
  if (res.status === 429) { console.error(`${name}: got 429. Turn rate limiting off (or dry-run) on the server under test.`); process.exit(2); }
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  const rl = [...res.headers.keys()].filter((k) => k.startsWith('x-ratelimit-')).sort();
  const rec = {
    name, request: `${method} ${norm(path)}`, status: res.status,
    headers: {
      'content-type': (res.headers.get('content-type') || '').toLowerCase(),
      'access-control-allow-origin': res.headers.get('access-control-allow-origin') || '',
      'cache-control': res.headers.get('cache-control') || '',
      'retry-after': res.headers.has('retry-after') ? '<present>' : '',
      'x-ratelimit': rl.join(','),
    },
    body: json !== undefined ? norm(json) : text.length ? '<non-json>' : '<empty>',
  };
  results.push(rec);
  return { status: res.status, json, headers: res.headers, text, raw: res };
}

// ---------------------------------------------------------------- scenario
async function main() {
  const API_T = sign('api'), ADMIN_T = sign('admin');
  const expired = sign('api', undefined, { expiresIn: -60 });

  // --- health and auth failures
  await call('health', 'GET', '/api/health', { base: ORIGIN });
  await call('auth-none', 'GET', `/users?externalId=golden-${RUN}-a`);
  await call('auth-bad', 'GET', `/users?externalId=golden-${RUN}-a`, { token: 'not.a.token' });
  await call('auth-expired', 'GET', `/users?externalId=golden-${RUN}-a`, { token: expired });
  await call('auth-wrong-secret', 'GET', `/users?externalId=golden-${RUN}-a`, { token: jwt.sign({ projectId: PROJECT_ID, type: 'api' }, 'x'.repeat(40)) });
  await call('auth-unknown-project', 'GET', `/users?externalId=golden-${RUN}-a`, { token: jwt.sign({ projectId: '00000000-0000-4000-8000-00000000ffff', type: 'api' }, SECRET) });
  await call('preflight-messages', 'OPTIONS', '/messages', { headers: { 'access-control-request-method': 'POST' } });

  // --- users
  const ext = (s) => `golden-${RUN}-${s}`;
  const uA = (await call('users-create-a', 'POST', '/users', { token: API_T, body: { externalId: ext('a'), name: 'Golden A', email: `a-${RUN}@example.com`, metadata: { plan: 'pro' } } })).json?.data;
  await call('users-replace-a', 'POST', '/users', { token: API_T, body: { externalId: ext('a'), name: 'Golden A2' } });
  await call('users-restore-a', 'POST', '/users', { token: API_T, body: { externalId: ext('a'), name: 'Golden A', email: `a-${RUN}@example.com` } });
  const uB = (await call('users-create-b', 'POST', '/users', { token: API_T, body: { externalId: ext('b'), name: `Golden B ${RUN}` } })).json?.data;
  const uC = (await call('users-create-c', 'POST', '/users', { token: API_T, body: { externalId: ext('c'), name: 'Golden C' } })).json?.data;
  const uD = (await call('users-create-d', 'POST', '/users', { token: ADMIN_T, body: { externalId: ext('d'), name: 'Golden D' } })).json?.data;
  await call('users-invalid-no-name', 'POST', '/users', { token: API_T, body: { externalId: ext('x') } });
  await call('users-invalid-email', 'POST', '/users', { token: API_T, body: { name: 'x', email: 'not-an-email' } });
  await call('users-invalid-json', 'POST', '/users', { token: API_T, headers: { 'content-type': 'application/json' }, body: undefined, form: '{bad json' });
  await call('users-list-external', 'GET', `/users?externalId=${ext('a')}`, { token: API_T });
  await call('users-list-search', 'GET', `/users?search=Golden%20B%20${RUN}&limit=5`, { token: API_T });
  await call('users-list-limit-too-big', 'GET', '/users?limit=201', { token: API_T });
  await call('users-list-limit-nan', 'GET', '/users?limit=abc', { token: API_T });
  const tA = sign('user', uA.id), tB = sign('user', uB.id), tC = sign('user', uC.id);
  await call('users-list-as-user', 'GET', `/users?externalId=${ext('a')}`, { token: tA });
  await call('users-create-as-user', 'POST', '/users', { token: tA, body: { externalId: ext('u'), name: 'By user' } });

  // --- conversations
  const g = (await call('conv-create-group', 'POST', '/conversations', { token: API_T, body: { type: 'group', title: 'Golden', participantIds: [uA.id, uB.id], metadata: { topic: 'x' } } })).json?.data;
  const d = (await call('conv-create-direct-as-user', 'POST', '/conversations', { token: tA, body: { type: 'direct', participantIds: [uA.id, uD.id] } })).json?.data;
  await call('conv-create-duplicate-ids', 'POST', '/conversations', { token: API_T, body: { type: 'group', participantIds: [uA.id, uA.id] } });
  await call('conv-create-unknown-participant', 'POST', '/conversations', { token: API_T, body: { type: 'group', participantIds: [uA.id, '00000000-0000-4000-8000-00000000dead'] } });
  await call('conv-create-invalid-type', 'POST', '/conversations', { token: API_T, body: { type: 'nope', participantIds: [uA.id] } });
  await call('conv-create-empty-participants', 'POST', '/conversations', { token: API_T, body: { type: 'group', participantIds: [] } });
  await call('conv-list-api-user-a', 'GET', `/conversations?userId=${uA.id}`, { token: API_T });
  await call('conv-list-api-user-c', 'GET', `/conversations?userId=${uC.id}`, { token: API_T });
  await call('conv-list-as-a-own', 'GET', `/conversations?userId=${uA.id}`, { token: tA });
  await call('conv-list-as-a-foreign', 'GET', `/conversations?userId=${uC.id}`, { token: tA });
  await call('conv-list-as-c-own', 'GET', `/conversations?userId=${uC.id}`, { token: tC });
  await call('conv-list-type-filter', 'GET', `/conversations?userId=${uA.id}&type=direct`, { token: API_T });
  await call('conv-list-archived-false', 'GET', `/conversations?userId=${uA.id}&isArchived=false&limit=1`, { token: API_T });
  await call('conv-list-archived-true', 'GET', `/conversations?userId=${uA.id}&isArchived=true`, { token: API_T });

  // --- messages
  const base = { conversationId: g.id };
  await call('msg-send-user-a', 'POST', '/messages', { token: tA, body: { ...base, senderId: uA.id, content: 'Hello from A' } });
  const m2 = (await call('msg-send-api-as-b', 'POST', '/messages', { token: API_T, body: { ...base, senderId: uB.id, content: 'Hello from B' } })).json?.data;
  await call('msg-send-user-a-as-b', 'POST', '/messages', { token: tA, body: { ...base, senderId: uB.id, content: 'impersonation' } });
  await call('msg-send-outsider', 'POST', '/messages', { token: tC, body: { ...base, senderId: uC.id, content: 'not a member' } });
  await call('msg-send-api-non-participant-sender', 'POST', '/messages', { token: API_T, body: { ...base, senderId: uC.id, content: 'x' } });
  await call('msg-send-reply', 'POST', '/messages', { token: tB, body: { ...base, senderId: uB.id, content: 'a reply', parentId: m2?.id } });
  await call('msg-send-attachment', 'POST', '/messages', { token: tA, body: { ...base, senderId: uA.id, type: 'image', content: 'pic', attachments: [{ type: 'image', url: 'https://cdn.example.com/p.jpg', filename: 'p.jpg', mimeType: 'image/jpeg', sizeBytes: 100, width: 10, height: 20 }] } });
  await call('msg-send-attachment-only', 'POST', '/messages', { token: tA, body: { ...base, senderId: uA.id, type: 'file', attachments: [{ type: 'file', url: 'https://cdn.example.com/f.pdf' }] } });
  await call('msg-send-invalid-no-sender', 'POST', '/messages', { token: API_T, body: { ...base, content: 'x' } });
  await call('msg-send-invalid-type', 'POST', '/messages', { token: API_T, body: { ...base, senderId: uA.id, type: 'bogus', content: 'x' } });
  await call('msg-send-unknown-conversation', 'POST', '/messages', { token: API_T, body: { conversationId: '00000000-0000-4000-8000-00000000dead', senderId: uA.id, content: 'x' } });
  await call('msg-list-as-a', 'GET', `/messages?conversationId=${g.id}`, { token: tA });
  await call('msg-list-as-outsider', 'GET', `/messages?conversationId=${g.id}`, { token: tC });
  await call('msg-list-api-limit', 'GET', `/messages?conversationId=${g.id}&limit=2&offset=1`, { token: API_T });
  await call('msg-list-type-filter', 'GET', `/messages?conversationId=${g.id}&type=image`, { token: API_T });
  await call('msg-list-sender-filter', 'GET', `/messages?conversationId=${g.id}&senderId=${uB.id}`, { token: API_T });
  await call('msg-list-before-future', 'GET', `/messages?conversationId=${g.id}&before=2999-01-01T00:00:00Z`, { token: API_T });
  await call('msg-list-after-future', 'GET', `/messages?conversationId=${g.id}&after=2999-01-01T00:00:00Z`, { token: API_T });
  await call('msg-list-missing-conversation', 'GET', '/messages', { token: API_T });
  await call('msg-list-unknown-conversation', 'GET', '/messages?conversationId=00000000-0000-4000-8000-00000000dead', { token: API_T });

  // --- participants
  const P = `/conversations/${g.id}/participants`;
  await call('part-add-api', 'POST', P, { token: API_T, body: { userId: uC.id } });
  await call('part-add-again', 'POST', P, { token: API_T, body: { userId: uC.id } });
  await call('part-add-unknown-user', 'POST', P, { token: API_T, body: { userId: '00000000-0000-4000-8000-00000000dead' } });
  await call('part-add-invalid-body', 'POST', P, { token: API_T, body: { user: uC.id } });
  await call('part-add-as-member', 'POST', P, { token: tA, body: { userId: uD.id } });
  await call('part-add-as-outsider', 'POST', `/conversations/${d.id}/participants`, { token: tC, body: { userId: uC.id } });
  await call('part-add-unknown-conversation', 'POST', '/conversations/00000000-0000-4000-8000-00000000dead/participants', { token: API_T, body: { userId: uC.id } });
  await call('msg-list-as-c-after-add', 'GET', `/messages?conversationId=${g.id}&limit=1`, { token: tC });
  await call('part-remove-as-member', 'DELETE', `${P}/${uD.id}`, { token: tA });
  await call('part-remove-api', 'DELETE', `${P}/${uC.id}`, { token: API_T });
  await call('part-remove-again', 'DELETE', `${P}/${uC.id}`, { token: API_T });
  await call('part-remove-as-outsider', 'DELETE', `${P}/${uA.id}`, { token: tC });
  await call('msg-list-as-c-after-remove', 'GET', `/messages?conversationId=${g.id}&limit=1`, { token: tC });
  await call('msg-send-as-c-after-remove', 'POST', '/messages', { token: tC, body: { ...base, senderId: uC.id, content: 'after removal' } });
  await call('conv-list-as-c-after-remove', 'GET', `/conversations?userId=${uC.id}`, { token: tC });

  // --- uploads
  const fd = new FormData();
  fd.append('file', new Blob(['golden pdf'], { type: 'application/pdf' }), 'golden.pdf');
  fd.append('file', new Blob(['zip'], { type: 'application/zip' }), 'golden.zip');
  const up = await call('upload-mixed', 'POST', '/uploads', { token: tA, form: fd });
  await call('upload-no-files', 'POST', '/uploads', { token: tA, form: new FormData() });
  await call('upload-no-token', 'POST', '/uploads', { form: new FormData() });
  await call('upload-presign', 'POST', '/uploads/presign', { token: tA, body: { filename: 'a.png', mimeType: 'image/png', sizeBytes: 10 } });
  await call('upload-presign-invalid', 'POST', '/uploads/presign', { token: tA, body: { filename: 'a.png' } });
  const url = up.json?.data?.[0]?.url;
  if (url) await call('upload-serve', 'GET', new URL(url).pathname, { base: ORIGIN });
  await call('upload-serve-missing', 'GET', '/uploads/00000000-0000-4000-8000-00000000dead-nothing.pdf', { base: ORIGIN });

  // --- encryption routes (404 while E2EE is off; real answers when on). Deep E2EE behaviour is covered by
  //     scripts/smoke-e2ee.mjs and scripts/verify-e2ee.mjs; here we only freeze status and body for each route.
  const bogusDev = '00000000-0000-4000-8000-00000000d001';
  await call('e2ee-devices-list', 'GET', `/devices?userIds=${uA.id}`, { token: tA });
  await call('e2ee-devices-register-invalid', 'POST', '/devices', { token: tA, body: {} });
  await call('e2ee-devices-delete-unknown', 'DELETE', `/devices/${bogusDev}`, { token: tA });
  await call('e2ee-devices-pair-invalid', 'POST', '/devices/pair', { token: tA, body: {} });
  await call('e2ee-devices-link-invalid', 'POST', '/devices/link', { token: tA, body: {} });
  await call('e2ee-backup-get', 'GET', '/devices/backup', { token: tA });
  await call('e2ee-backup-put-invalid', 'PUT', '/devices/backup', { token: tA, body: {} });
  await call('e2ee-backup-delete', 'DELETE', '/devices/backup', { token: tA });
  await call('e2ee-conv-devices', 'GET', `/conversations/${g.id}/devices`, { token: tA });
  await call('e2ee-keys-get', 'GET', `/conversations/${g.id}/keys`, { token: tA });
  await call('e2ee-keys-post-invalid', 'POST', `/conversations/${g.id}/keys`, { token: tA, body: {} });
  await call('e2ee-keys-request-invalid', 'POST', `/conversations/${g.id}/keys/request`, { token: tA, body: {} });
  await call('e2ee-reset-as-user', 'POST', `/users/${uA.id}/devices/reset`, { token: tA });
  await call('e2ee-reset-as-admin', 'POST', `/users/${uA.id}/devices/reset`, { token: ADMIN_T });
  await call('e2ee-reset-as-api', 'POST', `/users/${uA.id}/devices/reset`, { token: API_T });

  // --- internal retry route
  await call('internal-retry-no-secret', 'POST', '/api/internal/webhooks/retry', { base: ORIGIN });
  await call('internal-retry-wrong-secret', 'POST', '/api/internal/webhooks/retry', { base: ORIGIN, token: 'wrong-secret' });
  await call('internal-retry-jwt', 'GET', '/api/internal/webhooks/retry', { base: ORIGIN, token: API_T });
  if (process.env.CRON_SECRET) await call('internal-retry-ok', 'POST', '/api/internal/webhooks/retry', { base: ORIGIN, token: process.env.CRON_SECRET });
}

await main();

const out = { label: LABEL, cases: results };
if (MODE === 'print') { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
if (MODE === 'record') {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n');
  console.log(`recorded ${results.length} cases -> ${BASELINE}`);
  process.exit(0);
}
if (!existsSync(BASELINE)) { console.error(`no baseline at ${BASELINE} (run with --record on a known-good build)`); process.exit(2); }
const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
const byName = new Map(base.cases.map((c) => [c.name, c]));
let bad = 0;
for (const c of results) {
  const b = byName.get(c.name);
  if (!b) { console.log(`  NEW   ${c.name} (not in baseline)`); bad++; continue; }
  byName.delete(c.name);
  const x = JSON.stringify(b, null, 2), y = JSON.stringify(c, null, 2);
  if (x !== y) {
    bad++; console.log(`  DIFF  ${c.name}  ${c.request}`);
    const xs = x.split('\n'), ys = y.split('\n');
    for (let i = 0; i < Math.max(xs.length, ys.length); i++) if (xs[i] !== ys[i]) { console.log(`        - ${xs[i] ?? ''}\n        + ${ys[i] ?? ''}`); }
  }
}
for (const n of byName.keys()) { console.log(`  GONE  ${n} (in baseline, not run)`); bad++; }
console.log(bad ? `\n${bad} difference(s) against ${BASELINE}` : `\nOK: ${results.length} cases match ${BASELINE}`);
process.exit(bad ? 1 : 0);
