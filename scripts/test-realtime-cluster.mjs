// Stage 5.6 end-to-end check: TWO instances behind no balancer, sharing one Redis. A message POSTed to one
// instance must reach a socket connected to the OTHER one. Without REDIS_URL on both instances this FAILS,
// which is exactly the silent-delivery-loss the Redis adapter exists to prevent.
//
//   # one Redis, two instances (any ports), both with REALTIME_PROVIDER=socketio and the same REDIS_URL:
//   REDIS_URL=redis://127.0.0.1:6379 REALTIME_PROVIDER=socketio PORT=3000 npm start      # terminal 1
//   REDIS_URL=redis://127.0.0.1:6379 REALTIME_PROVIDER=socketio PORT=3001 npm start      # terminal 2
//   JWT_SECRET=... node scripts/test-realtime-cluster.mjs                                # terminal 3
//
// Env: BASE_URL_A [http://localhost:3000], BASE_URL_B [http://localhost:3001], JWT_SECRET (required),
//      EVENT_WAIT_MS [5000], QUIET_MS [1500]. DEV/STAGING ONLY: it posts two messages to the seeded conversation.
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';

const A = process.env.BASE_URL_A || 'http://localhost:3000';
const B = process.env.BASE_URL_B || 'http://localhost:3001';
const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('export JWT_SECRET (same value both instances use)'); process.exit(2); }
const PROJECT_ID = process.env.PROJECT_ID || '00000000-0000-4000-8000-0000000000a2';
const ORG_ID = process.env.ORGANIZATION_ID || '00000000-0000-4000-8000-0000000000a1';
const CONV = process.env.CONVERSATION_ID || '00000000-0000-4000-8000-0000000000c1';
const SENDER = process.env.SENDER_ID || '00000000-0000-4000-8000-0000000000b1';
const OTHER = process.env.OTHER_USER_ID || '00000000-0000-4000-8000-0000000000b2';
const WAIT = Number(process.env.EVENT_WAIT_MS || 5000);
const QUIET = Number(process.env.QUIET_MS || 1500);

const sign = (p) => jwt.sign({ projectId: PROJECT_ID, organizationId: ORG_ID, ...p }, SECRET, { expiresIn: '1h' });
const apiToken = sign({ type: 'api' });
let failed = 0;
const check = (cond, m) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${m}`); if (!cond) failed = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = async (url, userId) => {
  const s = io(url, { auth: { token: sign({ userId, type: 'user' }) }, transports: ['websocket'], reconnection: false, forceNew: true });
  await new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); });
  const ack = await new Promise((res) => s.emit('join-conversation', { conversationId: CONV }, res));
  if (!ack.ok) throw new Error(`join failed on ${url}: ${ack.code}`);
  const got = []; s.on('message.created', (d) => got.push(d));
  return { s, got };
};
const waitFor = async (got, ms) => { const end = Date.now() + ms; while (!got.length && Date.now() < end) await sleep(25); return got[0] ?? null; };
const post = async (base, content) => {
  const r = await fetch(`${base}/api/v1/messages`, { method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: CONV, senderId: SENDER, content }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

console.log(`== instance A ${A}   instance B ${B}`);
const onA = await connect(A, SENDER);
const onB = await connect(B, OTHER);
check(true, 'a client is connected and joined on each instance');

console.log('== POST to B, client on A must receive it');
let r = await post(B, `cluster B->A ${Date.now()}`);
check(r.status === 201, `POST to B -> ${r.status}`);
let ev = await waitFor(onA.got, WAIT);
check(ev?.id === r.body.data?.id, 'client on instance A received the event published by instance B');
check((await waitFor(onB.got, WAIT))?.id === r.body.data?.id, 'client on instance B (same instance as the POST) received it too');
await sleep(QUIET);
check(onA.got.length === 1 && onB.got.length === 1, 'each client received it exactly once (no duplicates)');

console.log('== POST to A, client on B must receive it');
onA.got.length = 0; onB.got.length = 0;
r = await post(A, `cluster A->B ${Date.now()}`);
check(r.status === 201, `POST to A -> ${r.status}`);
ev = await waitFor(onB.got, WAIT);
check(ev?.id === r.body.data?.id, 'client on instance B received the event published by instance A');
check((await waitFor(onA.got, WAIT))?.id === r.body.data?.id, 'client on instance A received it too');
await sleep(QUIET);
check(onA.got.length === 1 && onB.got.length === 1, 'each client received it exactly once (no duplicates)');

onA.s.close(); onB.s.close();
console.log(failed ? '\nSOME CHECKS FAILED' : '\nSTAGE 5.6 CLUSTER CHECKS PASSED');
process.exit(failed);
