// SDK-3 end-to-end check: the BUILT SDK (packages/client/dist) against a RUNNING server with REALTIME_PROVIDER=socketio.
// DEV/STAGING ONLY: it creates one user and one message.
//
//   npm run build:sdk
//   psql "$DATABASE_URL" -f scripts/smoke-seed.sql
//   REALTIME_PROVIDER=socketio npm run dev:socket                       # terminal 1
//   JWT_SECRET=... node scripts/test-sdk-realtime.mjs                   # terminal 2 (same JWT_SECRET as the server)
//   RESTART_TEST=1 JWT_SECRET=... node scripts/test-sdk-realtime.mjs    # also checks reconnect: it asks you to restart the server
import jwt from 'jsonwebtoken';
import { createClient } from '../packages/client/dist/index.js';
import { createRealtime } from '../packages/client/dist/realtime.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PROJECT_ID = process.env.PROJECT_ID || '00000000-0000-4000-8000-0000000000a2';
const ORGANIZATION_ID = process.env.ORGANIZATION_ID || '00000000-0000-4000-8000-0000000000a1';
const CONVERSATION_ID = process.env.CONVERSATION_ID || '00000000-0000-4000-8000-0000000000c1';
const SENDER_ID = process.env.SENDER_ID || '00000000-0000-4000-8000-0000000000b1';
const OTHER_ID = process.env.OTHER_USER_ID || '00000000-0000-4000-8000-0000000000b2';
const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('export JWT_SECRET (same value the server uses)'); process.exit(2); }

const sign = (p, o = { expiresIn: '1h' }) => jwt.sign({ projectId: PROJECT_ID, organizationId: ORGANIZATION_ID, ...p }, SECRET, o);
let failed = 0;
const check = (cond, m) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${m}`); if (!cond) failed = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(25); return cond(); };
const codeOf = (p) => p.then(() => null, (e) => e.code);

const rest = createClient({ baseUrl: BASE_URL, token: sign({ type: 'api' }) });
const open = [];
const rt = (token) => { const r = createRealtime({ baseUrl: BASE_URL, token, reconnectionDelayMs: 500 }); open.push(r); return r; };

console.log('== handshake');
check((await codeOf(rt(() => '').connect())) === 'AUTH_REQUIRED', 'no token -> AUTH_REQUIRED');
check((await codeOf(rt(sign({ userId: SENDER_ID, type: 'user' }, { expiresIn: -10 })).connect())) === 'INVALID_TOKEN', 'expired token -> INVALID_TOKEN');

console.log('== two clients, REST post, event received');
const alice = rt(sign({ userId: SENDER_ID, type: 'user' }));
const bob = rt(sign({ userId: OTHER_ID, type: 'user' }));
const lurker = rt(sign({ userId: SENDER_ID, type: 'user' }));
await Promise.all([alice.connect(), bob.connect(), lurker.connect()]);
const gotA = [], gotB = [], gotL = [];
alice.on('message.created', (m) => gotA.push(m));
bob.on('message.created', (m) => gotB.push(m));
lurker.on('message.created', (m) => gotL.push(m));
await alice.joinConversation(CONVERSATION_ID);
await bob.joinConversation(CONVERSATION_ID);
check(true, 'both participants joined');

const outsider = await rest.users.upsert({ externalId: `sdk-rt-${Date.now()}`, name: 'Not a participant' });
const outsiderRt = rt(sign({ userId: outsider.id, type: 'user' }));
await outsiderRt.connect();
check((await codeOf(outsiderRt.joinConversation(CONVERSATION_ID))) === 'FORBIDDEN', 'non-participant join -> FORBIDDEN');

const sent = await rest.messages.send({ conversationId: CONVERSATION_ID, senderId: SENDER_ID, content: `sdk realtime ${Date.now()}` });
check(await waitFor(() => gotA.length > 0 && gotB.length > 0, 5000), 'both clients in the room received message.created');
check(gotA[0]?.id === sent.id, 'the event carries the same id as the REST response');
await sleep(1500);
check(gotL.length === 0, 'a connected client that did not join received nothing');

if (process.env.RESTART_TEST) {
  console.log('== reconnect: RESTART THE SERVER NOW (stop it, start it again)');
  check(await waitFor(() => alice.status === 'reconnecting', 120_000), 'client noticed the drop');
  check(await waitFor(() => alice.status === 'connected', 120_000), 'client reconnected by itself');
  gotA.length = 0;
  const again = await rest.messages.send({ conversationId: CONVERSATION_ID, senderId: SENDER_ID, content: 'after restart' });
  check(await waitFor(() => gotA.length > 0, 5000) && gotA[0].id === again.id, 'it re-joined the room: events flow again');
}

open.forEach((r) => r.disconnect());
console.log(failed ? '\nSOME CHECKS FAILED' : '\nSDK-3 E2E CHECKS PASSED');
process.exit(failed);
