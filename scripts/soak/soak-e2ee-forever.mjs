// Runs scripts/soak/soak-e2ee.mjs in back-to-back chunks, forever, so the soak survives a failed chunk and leaves one
// JSONL file per chunk. Run it under pm2 / systemd / a terminal on any machine that can reach staging.
//
//   JWT_SECRET=... BASE_URL=https://staging.example.com node scripts/soak/soak-e2ee-forever.mjs
//
// Env: CHUNK_S [3600] seconds per chunk, OUT_DIR [soak-e2ee-runs], ALERT_WEBHOOK_URL [none] (a POST with {text} is sent
// after a failed chunk; works with Slack-style incoming webhooks), plus everything soak-e2ee.mjs takes
// (GROUPS, OPS_PER_SEC, EVENT_WAIT_MS, BASE_URL, ...). Stops on SIGINT/SIGTERM. Exit 0 always: failures are recorded, not fatal. Exit 2/3 from a chunk (setup failed / server unreachable) back off instead of looping.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHUNK_S = Number(process.env.CHUNK_S || 3600);
const OUT_DIR = process.env.OUT_DIR || 'soak-e2ee-runs';
fs.mkdirSync(OUT_DIR, { recursive: true });
let stop = false, child = null;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop = true; child?.kill('SIGTERM'); });

const alert = (text) => process.env.ALERT_WEBHOOK_URL
  ? fetch(process.env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).catch(() => {})
  : Promise.resolve();
const wait = (ms) => new Promise((r) => { const t = setTimeout(r, ms); const iv = setInterval(() => { if (stop) { clearTimeout(t); clearInterval(iv); r(); } }, 500); setTimeout(() => clearInterval(iv), ms + 1000); });

// Exit codes of soak-e2ee.mjs: 0 clean, 1 a RULE broke (alert every time), 2 setup failed, 3 server unreachable.
// 2 and 3 are not rule failures: back off (30 s, doubling to 10 min) and alert ONCE per streak, plus once on recovery.
let n = 0, streak = 0, backoff = 30_000;
while (!stop) {
  n += 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(OUT_DIR, `chunk-${stamp}.jsonl`);
  const code = await new Promise((res) => {
    child = spawn(process.execPath, [path.join(here, 'soak-e2ee.mjs')], { stdio: 'inherit', env: { ...process.env, DURATION_S: String(CHUNK_S), OUT: out } });
    child.on('exit', (c) => res(c ?? 1));
  });
  const label = { 0: 'CLEAN', 1: 'FAILED (a rule broke)', 2: 'SETUP FAILED', 3: 'SERVER UNREACHABLE' }[code] || `exit ${code}`;
  const line = `[${new Date().toISOString()}] chunk ${n} ${label} -> ${out}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT_DIR, 'chunks.log'), line + '\n');
  if (code === 0 || code === 1) {
    if (streak > 0) await alert(`E2EE soak: server reachable again after ${streak} failed attempt(s)`);
    streak = 0; backoff = 30_000;
    if (code === 1) await alert(`E2EE soak: ${line}`);
  } else {
    streak += 1;
    if (streak === 1) await alert(`E2EE soak: ${line} (backing off, will retry; one alert per outage)`);
    console.error(`not retrying in a tight loop: waiting ${Math.round(backoff / 1000)} s`);
    await wait(backoff);
    backoff = Math.min(backoff * 2, 600_000);
  }
}
