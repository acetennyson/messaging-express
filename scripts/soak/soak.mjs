// Stage 5.4 soak load generator. Drives a RUNNING server with production-like traffic and records
// what a user would feel: REST latency/errors, socket delivery latency, missed deliveries,
// connection errors and reconnect churn. Pair it with the server's `server_stats` log lines
// (SOAK_STATS_INTERVAL_MS) and `node scripts/soak/summarize.mjs`. See docs/SOAK_RUNBOOK.md.
//
//   JWT_SECRET=... DURATION_S=600 SOCKETS=100 RATE=10 node scripts/soak/soak.mjs
//
// Env (defaults in brackets):
//   BASE_URL [http://localhost:3000]   JWT_SECRET (required, same as the server)
//   DURATION_S [60]     how long to generate load
//   RATE [10]           REST messages per second, in total
//   SOCKETS [50]        sockets to hold open (0 or REALTIME=off => REST only, the "next start" baseline run)
//   PROBES [5]          of those, how many never churn and must receive EVERY message (missed-delivery check)
//   CHURN_PER_MIN [0.2] fraction of the non-probe sockets that disconnect and reconnect each minute
//   REALTIME [on]       off => skip sockets entirely
//   OUT [soak-<ts>.jsonl]  one JSON line per 10 s window + a final summary line
//
// DEV/STAGING ONLY: it posts RATE x DURATION_S messages into the seeded conversation.
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import fs from 'fs';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('export JWT_SECRET (same value the server uses)'); process.exit(2); }
const PROJECT_ID = process.env.PROJECT_ID || '00000000-0000-4000-8000-0000000000a2';
const ORG_ID = process.env.ORGANIZATION_ID || '00000000-0000-4000-8000-0000000000a1';
const CONV = process.env.CONVERSATION_ID || '00000000-0000-4000-8000-0000000000c1';
const SENDER = process.env.SENDER_ID || '00000000-0000-4000-8000-0000000000b1';
const OTHER = process.env.OTHER_USER_ID || '00000000-0000-4000-8000-0000000000b2';
const DURATION_S = Number(process.env.DURATION_S || 60);
const RATE = Number(process.env.RATE || 10);
const REALTIME = (process.env.REALTIME || 'on') !== 'off';
const SOCKETS = REALTIME ? Number(process.env.SOCKETS ?? 50) : 0;
const PROBES = Math.min(SOCKETS, Number(process.env.PROBES || 5));
const CHURN_PER_MIN = Number(process.env.CHURN_PER_MIN ?? 0.2);
const OUT = process.env.OUT || `soak-${Date.now()}.jsonl`;
const WINDOW_MS = 10_000;

const tok = (userId, type = 'user', expiresIn = '12h') =>
  jwt.sign({ projectId: PROJECT_ID, organizationId: ORG_ID, userId, type }, SECRET, { expiresIn });
const apiToken = jwt.sign({ projectId: PROJECT_ID, organizationId: ORG_ID, type: 'api' }, SECRET, { expiresIn: '12h' });

const pct = (arr, p) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return Math.round(a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)] * 10) / 10;
};
const lat = (arr) => ({ n: arr.length, p50: pct(arr, 50), p95: pct(arr, 95), p99: pct(arr, 99), max: pct(arr, 100) });

// ---- accumulators: `win` resets every window, `tot` never does ----
const fresh = () => ({ rest: [], restErr: 0, restStatus: {}, delivery: [], connects: 0, connectErrors: 0, disconnects: 0, joinFail: 0 });
let win = fresh();
const tot = fresh();
const bump = (k, n = 1) => { win[k] += n; tot[k] += n; };
const push = (k, v) => { win[k].push(v); tot[k].push(v); };

// ---- sockets ----
const sockets = []; // { s, probe, userId }
const sent = new Map(); // messageId -> request start (ms)
const probeGot = new Map(); // messageId -> number of probes that received it
const probeStartedAt = []; // per-probe time it finished joining
let stopping = false;

function openSocket(slot) {
  const userId = slot.userId;
  const s = io(BASE_URL, { auth: { token: tok(userId) }, transports: ['websocket'], reconnection: false, forceNew: true });
  slot.s = s;
  s.on('connect', () => {
    bump('connects');
    s.emit('join-conversation', { conversationId: CONV }, (ack) => {
      if (!ack?.ok) return bump('joinFail');
      if (slot.probe && slot.joinedAt === undefined) { slot.joinedAt = Date.now(); }
    });
  });
  s.on('connect_error', () => bump('connectErrors'));
  s.on('disconnect', () => { if (!stopping) bump('disconnects'); });
  s.on('message.created', (m) => {
    const t0 = sent.get(m.id);
    if (t0 !== undefined) push('delivery', Date.now() - t0);
    if (slot.probe) probeGot.set(m.id, (probeGot.get(m.id) || 0) + 1);
  });
}

if (SOCKETS > 0) {
  for (let i = 0; i < SOCKETS; i++) {
    const slot = { probe: i < PROBES, userId: i % 2 ? OTHER : SENDER };
    sockets.push(slot);
    openSocket(slot);
    await new Promise((r) => setTimeout(r, 15)); // ramp, do not stampede
  }
  await new Promise((r) => setTimeout(r, 1500));
}

// ---- churn: non-probe sockets drop and come back ----
const churners = sockets.filter((x) => !x.probe);
const churnTimer = churners.length && CHURN_PER_MIN > 0
  ? setInterval(() => {
      const n = Math.max(1, Math.round(churners.length * CHURN_PER_MIN / 6)); // runs every 10 s
      for (let i = 0; i < n; i++) {
        const slot = churners[Math.floor(Math.random() * churners.length)];
        slot.s?.close();
        openSocket(slot);
      }
    }, 10_000)
  : null;

// ---- REST senders: open-loop at RATE msg/s ----
const sentIds = []; // [{ id, at }]
async function sendOne(n) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE_URL}/api/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: CONV, senderId: SENDER, content: `soak ${n}` }),
    });
    const ms = Date.now() - t0;
    const body = await r.json().catch(() => ({}));
    win.restStatus[r.status] = (win.restStatus[r.status] || 0) + 1;
    tot.restStatus[r.status] = (tot.restStatus[r.status] || 0) + 1;
    push('rest', ms);
    if (r.status === 201 && body?.data?.id) {
      sent.set(body.data.id, t0);
      sentIds.push({ id: body.data.id, at: t0 });
    } else bump('restErr');
  } catch {
    bump('restErr');
    win.restStatus.network = (win.restStatus.network || 0) + 1;
    tot.restStatus.network = (tot.restStatus.network || 0) + 1;
  }
}
const startedAt = Date.now();
let n = 0;
const sendTimer = setInterval(() => {
  const due = Math.floor(((Date.now() - startedAt) / 1000) * RATE);
  while (n < due) void sendOne(n++);
}, 50);

// ---- windows ----
const out = fs.createWriteStream(OUT);
const windowTimer = setInterval(() => {
  const line = {
    t: new Date().toISOString(), elapsedS: Math.round((Date.now() - startedAt) / 1000),
    rest: lat(win.rest), restErr: win.restErr, restStatus: win.restStatus,
    delivery: lat(win.delivery), connects: win.connects, connectErrors: win.connectErrors,
    disconnects: win.disconnects, joinFail: win.joinFail,
  };
  out.write(JSON.stringify(line) + '\n');
  console.log(`[${String(line.elapsedS).padStart(4)}s] REST p50/p95 ${line.rest.p50}/${line.rest.p95} ms err ${line.restErr} | delivery p50/p95 ${line.delivery.p50}/${line.delivery.p95} ms | conn+${line.connects} err ${line.connectErrors} drop ${line.disconnects}`);
  win = fresh();
}, WINDOW_MS);

await new Promise((r) => setTimeout(r, DURATION_S * 1000));
clearInterval(sendTimer);
clearInterval(windowTimer);
if (churnTimer) clearInterval(churnTimer);
await new Promise((r) => setTimeout(r, 3000)); // let in-flight requests and events land

// ---- missed deliveries: every message sent after a probe finished joining must reach it ----
const liveProbes = sockets.filter((x) => x.probe && x.joinedAt !== undefined);
let missed = 0, expected = 0;
for (const { id, at } of sentIds) {
  const eligible = liveProbes.filter((p) => p.joinedAt < at).length;
  expected += eligible;
  missed += Math.max(0, eligible - (probeGot.get(id) || 0));
}

stopping = true;
sockets.forEach((x) => x.s?.close());
const summary = {
  summary: true, startedAt: new Date(startedAt).toISOString(), durationS: DURATION_S, rate: RATE,
  sockets: SOCKETS, probes: PROBES, realtime: REALTIME,
  restRequests: tot.rest.length, rest: lat(tot.rest), restErr: tot.restErr, restStatus: tot.restStatus,
  restErrorRate: tot.rest.length ? Math.round((tot.restErr / tot.rest.length) * 10000) / 100 : 0,
  delivery: lat(tot.delivery), probeExpected: expected, probeMissed: missed,
  probeMissRate: expected ? Math.round((missed / expected) * 10000) / 100 : 0,
  connects: tot.connects, connectErrors: tot.connectErrors, disconnects: tot.disconnects, joinFail: tot.joinFail,
};
out.write(JSON.stringify(summary) + '\n');
out.end();
console.log('\nSUMMARY\n' + JSON.stringify(summary, null, 2));
console.log(`\nwritten to ${OUT}`);
await new Promise((r) => setTimeout(r, 500));
process.exit(0);
