// Runs scripts/soak/soak-e2ee.mjs in back-to-back chunks, forever, so the soak survives a failed chunk and leaves one
// JSONL file per chunk. Run it under pm2 / systemd / a terminal on any machine that can reach staging.
//
//   JWT_SECRET=... BASE_URL=https://staging.example.com node scripts/soak/soak-e2ee-forever.mjs
//
// Env: CHUNK_S [3600] seconds per chunk, OUT_DIR [soak-e2ee-runs], ALERT_WEBHOOK_URL [none] (a POST with {text} is sent
// after a failed chunk; works with Slack-style incoming webhooks), plus everything soak-e2ee.mjs takes
// (GROUPS, OPS_PER_SEC, EVENT_WAIT_MS, BASE_URL, ...). Stops on SIGINT/SIGTERM. Exit 0 always: failures are recorded, not fatal.
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

let n = 0;
while (!stop) {
  n += 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(OUT_DIR, `chunk-${stamp}.jsonl`);
  const code = await new Promise((res) => {
    child = spawn(process.execPath, [path.join(here, 'soak-e2ee.mjs')], { stdio: 'inherit', env: { ...process.env, DURATION_S: String(CHUNK_S), OUT: out } });
    child.on('exit', (c) => res(c ?? 1));
  });
  const line = `[${new Date().toISOString()}] chunk ${n} ${code === 0 ? 'CLEAN' : 'FAILED (exit ' + code + ')'} -> ${out}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT_DIR, 'chunks.log'), line + '\n');
  if (code !== 0 && process.env.ALERT_WEBHOOK_URL) {
    await fetch(process.env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `E2EE soak: ${line}` }) }).catch(() => {});
  }
  if (code === 2) { console.error('setup failed (exit 2): not retrying in a tight loop, waiting 60 s'); await new Promise((r) => setTimeout(r, 60_000)); }
}
