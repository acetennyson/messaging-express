// Stage 5.3 end-to-end check against a RUNNING server started with REALTIME_PROVIDER=socketio
// (npm run dev:socket, or npm start after npm run build). Uses the real REST API to trigger the event.
//
//   REALTIME_PROVIDER=socketio npm run dev:socket        # terminal 1 (after: psql "$DATABASE_URL" -f scripts/smoke-seed.sql)
//   JWT_SECRET=... node scripts/test-realtime.mjs        # terminal 2   (same JWT_SECRET as the server)
//
// DEV/STAGING ONLY: it creates one user and one message.
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PROJECT_ID = process.env.PROJECT_ID || '00000000-0000-4000-8000-0000000000a2';
const ORGANIZATION_ID = process.env.ORGANIZATION_ID || '00000000-0000-4000-8000-0000000000a1';
const CONVERSATION_ID = process.env.CONVERSATION_ID || '00000000-0000-4000-8000-0000000000c1';
const SENDER_ID = process.env.SENDER_ID || '00000000-0000-4000-8000-0000000000b1';
const OTHER_ID = process.env.OTHER_USER_ID || '00000000-0000-4000-8000-0000000000b2';
const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('export JWT_SECRET (same value the server uses)'); process.exit(2); }

const sign = (p, o = { expiresIn: '1h' }) => jwt.sign({ projectId: PROJECT_ID, organizationId: ORGANIZATION_ID, ...p }, SECRET, o);
const apiToken = sign({ type: 'api' });
let failed = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); failed = 1; };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const connect = (token) => io(BASE_URL, { auth: token === null ? {} : { token }, transports: ['websocket'], reconnection: false, forceNew: true });
const connected = (s) => new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); });
const rejected = (s) => new Promise((res) => s.once('connect_error', res));
const join = (s, id) => new Promise((res) => s.emit('join-conversation', { conversationId: id }, res));
// Record events from the moment we start listening; the wait only begins AFTER the REST call returns,
// so a slow database (seconds per request) cannot make the check give up before the event is even sent.
const recorder = (s, name) => { const got = []; s.on(name, (d) => got.push(d)); return got; };
const EVENT_WAIT_MS = Number(process.env.EVENT_WAIT_MS || 5000);   // max wait for an event that SHOULD arrive
const QUIET_MS = Number(process.env.QUIET_MS || 1500);             // extra wait before declaring "received nothing"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (got, ms) => { const end = Date.now() + ms; while (!got.length && Date.now() < end) await sleep(25); return got[0] ?? null; };
const rest = async (path, body) => {
  const r = await fetch(`${BASE_URL}/api/v1/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const open = [];
const track = (s) => (open.push(s), s);

console.log('== handshake');
check((await rejected(track(connect(null)))).data?.code === 'AUTH_REQUIRED', 'no token -> rejected (AUTH_REQUIRED)');
const expired = jwt.sign({ projectId: PROJECT_ID, userId: SENDER_ID, type: 'user' }, SECRET, { expiresIn: -10 });
check((await rejected(track(connect(expired)))).data?.code === 'INVALID_TOKEN', 'expired token -> rejected (INVALID_TOKEN)');

console.log('== rooms');
const alice = track(connect(sign({ userId: SENDER_ID, type: 'user' })));
const bob = track(connect(sign({ userId: OTHER_ID, type: 'user' })));
const lurker = track(connect(sign({ userId: SENDER_ID, type: 'user' })));      // connected, never joins
await Promise.all([connected(alice), connected(bob), connected(lurker)]);
check((await join(alice, CONVERSATION_ID)).ok === true, 'participant joins -> ack ok');
check((await join(bob, CONVERSATION_ID)).ok === true, 'second participant joins -> ack ok');

const u = await rest('users', { externalId: `rt-${Date.now()}`, name: 'Not a participant' });
const outsider = track(connect(sign({ userId: u.body.data?.id, type: 'user' })));
await connected(outsider);
check((await join(outsider, CONVERSATION_ID)).code === 'FORBIDDEN', 'non-participant -> FORBIDDEN');

console.log('== delivery over REST -> socket');
const gotAlice = recorder(alice, 'message.created'), gotBob = recorder(bob, 'message.created');
const gotLurker = recorder(lurker, 'message.created'), gotOutsider = recorder(outsider, 'message.created');
const post = await rest('messages', { conversationId: CONVERSATION_ID, senderId: SENDER_ID, content: `realtime ${Date.now()}` });
check(post.status === 201, `POST /messages -> ${post.status}`);
const ea = await waitFor(gotAlice, EVENT_WAIT_MS), eb = await waitFor(gotBob, EVENT_WAIT_MS);
check(ea?.id === post.body.data?.id, 'client in the room received message.created (same id as the REST response)');
check(eb?.id === post.body.data?.id, 'second client in the room received it too');
await sleep(QUIET_MS); // by now the event has been delivered to everyone it is going to reach
check(gotLurker.length === 0, 'connected client that did NOT join received nothing');
check(gotOutsider.length === 0, 'rejected non-participant received nothing');

open.forEach((s) => s.close());
console.log(failed ? '\nSOME CHECKS FAILED' : '\nSTAGE 5.3 E2E CHECKS PASSED');
process.exit(failed);
