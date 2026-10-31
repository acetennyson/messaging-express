// Reads the server's log (stdout/stderr JSON lines) and reports what the E2EE rollout needs watched:
// error-level lines by message, `rate_limit_would_block` per route group, and the server_stats trend.
//
//   node scripts/soak/e2ee-log-report.mjs server.log [--since 2026-10-31T00:00:00Z]
//
// Exit code 1 when there are error-level lines from E2EE code paths or any would-block on the E2EE groups,
// so it can run from cron / CI after a soak.
import fs from 'fs';

const file = process.argv[2];
if (!file) { console.error('usage: e2ee-log-report.mjs <server.log> [--since <iso>]'); process.exit(2); }
const sinceArg = process.argv.indexOf('--since');
const since = sinceArg > 0 ? Date.parse(process.argv[sinceArg + 1]) : 0;

const E2EE_GROUPS = ['devices', 'devices/pair', 'devices/link', 'devices/backup', 'conversations/keys/request'];
const errors = new Map(), blocks = new Map(), stats = [];
let lines = 0, parsed = 0;
for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
  lines += 1;
  const i = raw.indexOf('{"timestamp"');
  if (i < 0) continue;
  let o;
  try { o = JSON.parse(raw.slice(i)); } catch { continue; }
  parsed += 1;
  if (since && Date.parse(o.timestamp) < since) continue;
  if (o.level === 'error') errors.set(o.message, (errors.get(o.message) || 0) + 1);
  if (o.message === 'rate_limit_would_block') {
    const g = o.meta?.group || o.meta?.path || 'unknown';
    blocks.set(g, (blocks.get(g) || 0) + 1);
  }
  if (o.message === 'server_stats') stats.push(o);
}
console.log(`# E2EE log report: ${parsed} JSON log lines read from ${file}${since ? ` since ${new Date(since).toISOString()}` : ''}\n`);
console.log('## Error-level lines');
if (!errors.size) console.log('none');
for (const [m, n] of [...errors].sort((a, b) => b[1] - a[1])) console.log(`- ${m}: ${n}`);
console.log('\n## rate_limit_would_block by group');
if (!blocks.size) console.log('none');
for (const [g, n] of [...blocks].sort((a, b) => b[1] - a[1])) console.log(`- ${g}: ${n}${E2EE_GROUPS.includes(g) ? '   <- E2EE group, raise its limit or investigate the client' : ''}`);
if (stats.length >= 2) {
  const f = stats[0], l = stats[stats.length - 1];
  const rss = (s) => Math.round((s.meta?.rssMb ?? s.meta?.rss ?? NaN) * 10) / 10;
  console.log(`\n## server_stats: ${stats.length} samples, ${f.timestamp} -> ${l.timestamp}`);
  console.log(`- rss ${rss(f)} -> ${rss(l)} (MB; a steady climb over days is the thing to worry about)`);
  console.log(`- realtime ${JSON.stringify(f.meta?.realtime)} -> ${JSON.stringify(l.meta?.realtime)}`);
}
const bad = [...errors.keys()].some((m) => /e2ee|device|keys|backup|participant/i.test(m)) || E2EE_GROUPS.some((g) => blocks.has(g));
console.log(`\n${bad ? 'INVESTIGATE' : 'OK'}`);
process.exit(bad ? 1 : 0);
