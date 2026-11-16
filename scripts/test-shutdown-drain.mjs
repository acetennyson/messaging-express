// Proves a graceful shutdown waits for an in-flight webhook instead of dropping it.
//   DATABASE_URL=... JWT_SECRET=... node scripts/test-shutdown-drain.mjs
// It starts its own server (port 3399, WEBHOOK_DISPATCH=on), points the seed organization's webhook at a slow local receiver,
// sends a message, checks server.ts's own in-flight gauge sees that webhook (the tracker is shared across Next's separately
// bundled routes and server.ts), then SIGTERMs the server while the receiver is still "thinking" and checks the webhook was
// completed and the server exited cleanly. (Next's own close also waits for after() work, so shutdown timing alone cannot
// tell the tracker's drain from Next's; the shared-set check above is what pins our wiring.) The organization's webhook settings are restored afterwards.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import pg from 'pg';
import jwt from 'jsonwebtoken';

if (process.platform === 'win32') {
  // Windows cannot deliver a graceful SIGTERM to a child process (it is a hard kill), so this check would prove nothing there.
  console.log('SKIPPED: needs POSIX signals. Run it on Linux/macOS/WSL/CI.');
  process.exit(0);
}
const DATABASE_URL = process.env.DATABASE_URL, SECRET = process.env.JWT_SECRET;
if (!DATABASE_URL || !SECRET) { console.error('set JWT_SECRET and DATABASE_URL (same as the server)'); process.exit(2); }
const PORT = 3399, RECV_PORT = 3398, SLOW_MS = 3500;
const ORG = '00000000-0000-4000-8000-0000000000a1', PROJECT = '00000000-0000-4000-8000-0000000000a2';
const CONV = '00000000-0000-4000-8000-0000000000c1', SENDER = '00000000-0000-4000-8000-0000000000b1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };

const db = new pg.Client({ connectionString: DATABASE_URL }); await db.connect();
const before = (await db.query('SELECT webhook_url, webhook_secret FROM mx_organizations WHERE id = $1', [ORG])).rows[0];

// "finished" counts only responses that reached a still-connected server; "dropped" counts requests the server abandoned.
let started = 0, finished = 0, dropped = 0;
const receiver = http.createServer((req, res) => {
  started++;
  req.resume();
  res.on('finish', () => { finished++; });
  res.on('close', () => { if (!res.writableFinished) dropped++; });
  setTimeout(() => { if (!res.destroyed) { res.writeHead(200); res.end('ok'); } }, SLOW_MS);
}).listen(RECV_PORT);

const logs = [];
// Run tsx's CLI directly (not through npx) so the signal below reaches the server itself, not a wrapper.
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const server = spawn(process.execPath, [tsxCli, 'server.ts', '--dev'], {
  env: { ...process.env, PORT: String(PORT), APP_URL: `http://localhost:${PORT}`, WEBHOOK_DISPATCH: 'on', RATE_LIMIT_MODE: 'off', SHUTDOWN_TIMEOUT_MS: '10000', SOAK_STATS_INTERVAL_MS: '100' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => logs.push(String(d))); server.stderr.on('data', (d) => logs.push(String(d)));
const exited = new Promise((r) => server.on('exit', (code) => r(code)));
const killGroup = (sig) => { try { server.kill(sig); } catch {} };

try {
  await db.query('UPDATE mx_organizations SET webhook_url = $2, webhook_secret = NULL WHERE id = $1', [ORG, `http://127.0.0.1:${RECV_PORT}/hook`]);
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) break; } catch {} await sleep(1000); }

  const token = jwt.sign({ projectId: PROJECT, organizationId: ORG, type: 'api' }, SECRET, { expiresIn: '1h' });
  const r = await fetch(`http://localhost:${PORT}/api/v1/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: CONV, senderId: SENDER, content: 'drain check', type: 'text' }),
  });
  check(r.status === 201, `message created (${r.status})`);
  for (let i = 0; i < 100 && started === 0; i++) await sleep(50);
  check(started === 1 && finished === 0, 'webhook request is in flight (receiver is still thinking)');

  // server.ts counts in-flight work with its own tracker; it must see the route bundle's webhook (one shared set).
  for (let i = 0; i < 40 && !/"inflight":\s*[1-9]/.test(logs.join('')); i++) await sleep(50);
  check(/"inflight":\s*[1-9]/.test(logs.join('')), 'server.ts sees the route\'s in-flight webhook (shared in-flight set across bundles)');

  const t0 = Date.now();
  killGroup('SIGTERM');
  const code = await Promise.race([exited, sleep(20000).then(() => 'timeout')]);
  check(finished === 1 && dropped === 0, `shutdown waited: the webhook completed (finished=${finished}, dropped=${dropped}, ${Date.now() - t0}ms after SIGTERM)`);
  check(code === 0, `server exited cleanly (code ${code})`);
  const all = logs.join('');
  check(!all.includes('shutdown_inflight_abandoned'), 'no "shutdown_inflight_abandoned" warning');
  check(all.includes('shutdown_started'), 'shutdown was logged');
} finally {
  killGroup('SIGKILL');
  await db.query('UPDATE mx_organizations SET webhook_url = $2, webhook_secret = $3 WHERE id = $1', [ORG, before?.webhook_url ?? null, before?.webhook_secret ?? null]);
  await db.end(); receiver.close();
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nSHUTDOWN DRAIN OK');
process.exit(failed ? 1 : 0);
