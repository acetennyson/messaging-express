// One-command check of the client SDK (uploads, REST, realtime) against YOUR running dev server.
// DEV / STAGING ONLY: it seeds the smoke fixtures and creates a few users, conversations and messages.
//
//   1) terminal 1:   npm run dev:socket          (needs REALTIME_PROVIDER=socketio in .env.local)
//   2) terminal 2:   node scripts/verify-sdk.mjs
//
// It reads DATABASE_URL and JWT_SECRET from .env.local by itself. Options (environment variables):
//   BASE_URL=http://localhost:3000   SKIP_BUILD=1 (do not rebuild the SDK)   SKIP_SEED=1 (do not touch the database)
//   RESTART_TEST=1  also test reconnecting: the script then asks you to stop and start the server
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- load .env.local / .env (does not override variables you already set) ----
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

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000a2';
const USER1 = '00000000-0000-4000-8000-0000000000b1';
const USER2 = '00000000-0000-4000-8000-0000000000b2';
const CONV = '00000000-0000-4000-8000-0000000000c1';

let failed = 0;
const say = (s = '') => console.log(s);
const check = (cond, label, hint) => {
  say(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { failed += 1; if (hint) say(`        -> ${hint}`); }
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(25); return cond(); };
const codeOf = (p) => p.then(() => null, (e) => e?.code ?? String(e));
const die = (msg) => { say(`\nSTOPPED: ${msg}`); process.exit(2); };

if (!process.env.JWT_SECRET) die('JWT_SECRET not found. Put it in .env.local (the same value your server uses).');

// ---- 0. is the server up? ----
say('== 0. Server');
let BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
BASE_URL = BASE_URL.replace(/\/+$/, '');
const tryHealth = async (url) => {
  try { const r = await fetch(`${url}/api/health`); return { ok: r.ok, status: r.status }; }
  catch (e) { return { error: e?.cause?.code || e?.cause?.message || e?.message || String(e) }; }
};
let health = await tryHealth(BASE_URL);
if (health.error && /localhost/.test(BASE_URL)) {
  // On Windows "localhost" can resolve to IPv6 (::1) while the server listens on IPv4 only.
  const alt = BASE_URL.replace('localhost', '127.0.0.1');
  const h2 = await tryHealth(alt);
  if (!h2.error) { say(`  (localhost did not answer but ${alt} does: using that)`); BASE_URL = alt; health = h2; }
}
if (health.error) {
  die(`could not reach ${BASE_URL}/api/health (${health.error}).\n` +
      `  -> Is the server running? Open ANOTHER terminal in this folder and run:  npm run dev:socket\n` +
      `     wait until you see "server_listening", then run this script again.\n` +
      `  -> Different port? Run with:  set BASE_URL=http://localhost:PORT   (cmd)   or   BASE_URL=http://localhost:PORT node scripts/verify-sdk.mjs   (Git Bash)`);
}
check(health.ok, `server answers at ${BASE_URL}/api/health (HTTP ${health.status})`,
  'The server is up but unhealthy: the database is probably unreachable. Check DATABASE_URL in .env.local and the server terminal for errors.');

// ---- 1. build the SDK ----
if (!process.env.SKIP_BUILD) {
  say('\n== 1. Building the SDK');
  const b = spawnSync('npm run build:sdk', { cwd: root, shell: true, encoding: 'utf8' });
  if (b.status !== 0) { say(b.stdout + b.stderr); die('SDK build failed (see above).'); }
  check(true, 'npm run build:sdk');
}

// ---- 2. seed the database ----
if (!process.env.SKIP_SEED) {
  say('\n== 2. Seeding the smoke fixtures (one org, project, 2 users, 1 conversation; safe to repeat)');
  if (!process.env.DATABASE_URL) die('DATABASE_URL not found in .env.local');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(readFileSync(path.join(root, 'scripts', 'smoke-seed.sql'), 'utf8'));
    check(true, 'scripts/smoke-seed.sql applied');
  } catch (e) {
    die(`could not seed the database: ${e.message}\n(Did you run "npm run db:migrate" first?)`);
  } finally {
    await pool.end();
  }
}

// ---- tokens and SDK ----
const { default: jwt } = await import('jsonwebtoken');
const sign = (extra, opts = { expiresIn: '1h' }) => jwt.sign({ projectId: PROJECT, organizationId: ORG, ...extra }, process.env.JWT_SECRET, opts);
const apiToken = sign({ type: 'api' });
const userToken = (userId, opts) => sign({ userId, type: 'user' }, opts);
const { createClient } = await import(pathToFileURL(path.join(root, 'packages/client/dist/index.js')).href);
const { createRealtime } = await import(pathToFileURL(path.join(root, 'packages/client/dist/realtime.js')).href);
const client = createClient({ baseUrl: BASE_URL, token: apiToken });

// ---- 3. uploads (SDK-1) ----
say('\n== 3. Uploads');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const file = new File([PNG], 'dot.png', { type: 'image/png' });
const progress = [];
const [outcome] = await client.uploads.upload([file], { onProgress: (i, p) => progress.push(p) });
check(outcome.ok, 'uploaded a 1x1 PNG through client.uploads.upload', outcome.ok ? '' : `${outcome.code}: ${outcome.error}`);
let attachment = null;
if (outcome.ok) {
  attachment = outcome.attachment;
  check(typeof attachment.url === 'string' && /^https?:\/\//.test(attachment.url), `attachment.url is an absolute URL (${attachment.url})`,
    'POST /messages requires an absolute URL. For the local provider set APP_URL (e.g. http://localhost:3000) in .env.local and restart the server.');
  check(attachment.type === 'image' && attachment.mimeType === 'image/png', 'attachment is typed image/png');
  check(progress.at(-1) === 100, 'progress reached 100');
}

// ---- 4. REST (SDK-2) ----
say('\n== 4. REST wrappers');
const ext = `verify-${Date.now()}`;
let user = null;
try {
  user = await client.users.upsert({ externalId: ext, name: 'SDK Verify' });
  check(!!user.id, 'users.upsert created a user');
  const again = await client.users.upsert({ externalId: ext, name: 'SDK Verify (renamed)' });
  check(again.id === user.id && again.name === 'SDK Verify (renamed)', 'users.upsert with the same externalId updated the same user');
  const found = await client.users.list({ externalId: ext });
  check(found.data.length === 1 && found.data[0].id === user.id, 'users.list finds it by externalId');
} catch (e) { check(false, 'users.*', `${e.code}: ${e.message}`); }

let conv = null;
try {
  conv = await client.conversations.create({ type: 'group', title: 'SDK verify', participantIds: [USER1, USER2] });
  check(conv.participants?.length === 2, 'conversations.create added both participants');
  const list = await client.conversations.list({ userId: USER1 });
  check(list.data.some((c) => c.id === conv.id), 'conversations.list (userId) includes it');
  const active = await client.conversations.list({ isArchived: false, userId: USER1 });
  const archived = await client.conversations.list({ isArchived: true, userId: USER1 });
  check(active.data.some((c) => c.id === conv.id), 'conversations.list({ isArchived: false }) includes it');
  check(!archived.data.some((c) => c.id === conv.id), 'conversations.list({ isArchived: true }) does not',
    'This needs the server-side isArchived fix (lib/validation/schemas.ts) and a server restart.');
} catch (e) { check(false, 'conversations.*', `${e.code}: ${e.message}`); }

let sent = null;
try {
  sent = await client.messages.send({ conversationId: CONV, senderId: USER1, content: `hello ${Date.now()}`,
    ...(attachment ? { type: 'image', attachments: [attachment] } : {}) });
  check(!!sent.id, `messages.send returned a message${attachment ? ' with the uploaded attachment' : ''}`);
  check(!attachment || sent.attachments?.length === 1, 'the attachment came back on the message');
  const page = await client.messages.list({ conversationId: CONV, limit: 5 });
  check(page.data[0]?.id === sent.id, 'messages.list returns it first (newest first)');
} catch (e) { check(false, 'messages.*', `${e.status ?? ''} ${e.code}: ${e.message}`); }
check((await codeOf(client.messages.send({ conversationId: CONV, senderId: user?.id ?? USER2.replace('b2', 'ff') }))) !== null,
  'a sender who is not a participant is rejected');

// ---- 5. realtime (SDK-3) ----
say('\n== 5. Realtime');
const open = [];
const rt = (token, extra = {}) => { const r = createRealtime({ baseUrl: BASE_URL, token, reconnectionDelayMs: 500, ...extra }); open.push(r); return r; };

const probe = rt(userToken(USER1));
const probeErr = await probe.connect().then(() => null, (e) => e);
if (probeErr) {
  check(false, 'connected to the Socket.IO server', probeErr.code === 'SOCKET_IO_MISSING'
    ? 'Run: npm i socket.io-client'
    : `${probeErr.code}. Is the server started with REALTIME_PROVIDER=socketio (npm run dev:socket)? Set it in .env.local and restart.`);
} else {
  check(true, 'connected with a user token');
  probe.disconnect();
  check((await codeOf(rt(() => '').connect())) === 'AUTH_REQUIRED', 'no token -> AUTH_REQUIRED');
  check((await codeOf(rt(userToken(USER1, { expiresIn: -10 })).connect())) === 'INVALID_TOKEN', 'expired token -> INVALID_TOKEN');
  check((await codeOf(rt(apiToken).connect().then(async () => { const r = open.at(-1); return r.joinConversation(CONV); }))) === 'FORBIDDEN',
    'an API token can connect but not join (needs a userId)');

  const alice = rt(userToken(USER1));
  const bob = rt(userToken(USER2));
  const lurker = rt(userToken(USER1));
  await Promise.all([alice.connect(), bob.connect(), lurker.connect()]);
  const gotA = [], gotB = [], gotL = [];
  alice.on('message.created', (m) => gotA.push(m));
  bob.on('message.created', (m) => gotB.push(m));
  lurker.on('message.created', (m) => gotL.push(m));
  await alice.joinConversation(CONV);
  await bob.joinConversation(CONV);
  check(true, 'two participants joined the conversation');

  const outsiderId = user?.id;
  if (outsiderId) {
    const outsider = rt(userToken(outsiderId));
    await outsider.connect();
    check((await codeOf(outsider.joinConversation(CONV))) === 'FORBIDDEN', 'a non-participant joining is refused (FORBIDDEN)');
  }

  const m = await client.messages.send({ conversationId: CONV, senderId: USER1, content: `realtime ${Date.now()}` });
  check(await waitFor(() => gotA.length > 0 && gotB.length > 0, 5000), 'both joined clients received message.created');
  check(gotA[0]?.id === m.id, 'the event is the same message the REST call returned');
  await sleep(1200);
  check(gotL.length === 0, 'a connected client that did NOT join received nothing');

  if (process.env.RESTART_TEST) {
    say('\n== 6. Reconnect. Now STOP the server (Ctrl+C) and START it again (npm run dev:socket). Waiting up to 3 minutes...');
    check(await waitFor(() => alice.status === 'reconnecting', 180_000), 'client noticed the drop');
    check(await waitFor(() => alice.status === 'connected', 180_000), 'client reconnected by itself');
    gotA.length = 0;
    const again = await client.messages.send({ conversationId: CONV, senderId: USER1, content: 'after restart' });
    check(await waitFor(() => gotA.length > 0, 5000) && gotA[0].id === again.id, 'it re-joined the room: events flow again');
  } else {
    say('\n(Reconnect test skipped. To run it too:  set RESTART_TEST=1   then run this script again.)');
  }
}

open.forEach((r) => r.disconnect());
say(failed ? `\n${failed} CHECK(S) FAILED. Copy everything above and send it to me.` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
