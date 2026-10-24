// Stage 5.4: turn a soak run into the numbers the written note needs.
//
//   node scripts/soak/summarize.mjs --server server.log --soak soak-123.jsonl [--baseline soak-baseline.jsonl]
//
//   --server    the server's stdout/stderr log containing `server_stats` lines (SOAK_STATS_INTERVAL_MS)
//   --soak      the soak.mjs output of the run against `start:socket`
//   --baseline  the soak.mjs output (REALTIME=off) of the same load against plain `next start`
//
// Prints a Markdown block to paste into the note, plus an OK / INVESTIGATE verdict per check.
// The thresholds are heuristics (documented below), not laws: read the raw numbers too.
import fs from 'fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
if (!args.soak) { console.error('usage: summarize.mjs --soak <soak.jsonl> [--server <server.log>] [--baseline <soak.jsonl>]'); process.exit(2); }

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const summaryOf = (f) => readJsonl(f).find((x) => x.summary);

const soak = summaryOf(args.soak);
if (!soak) { console.error('no summary line in', args.soak, '(did the run finish?)'); process.exit(1); }

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });
const skip = (name, detail) => checks.push({ name, ok: true, skipped: true, detail });

// 1. REST behaviour, optionally against the plain `next start` baseline
const rows = [['', 'REST p50', 'REST p95', 'REST p99', 'error rate', 'requests']];
const row = (label, s) => [label, `${s.rest.p50} ms`, `${s.rest.p95} ms`, `${s.rest.p99} ms`, `${s.restErrorRate}%`, s.restRequests];
if (args.baseline) {
  const base = summaryOf(args.baseline);
  rows.push(row('next start (baseline)', base), row('start:socket', soak));
  check('REST p95 within 25% (+15 ms) of baseline', soak.rest.p95 <= base.rest.p95 * 1.25 + 15, `${soak.rest.p95} vs ${base.rest.p95} ms`);
  check('REST error rate not above baseline (+0.5 pt)', soak.restErrorRate <= base.restErrorRate + 0.5, `${soak.restErrorRate}% vs ${base.restErrorRate}%`);
} else {
  rows.push(row('start:socket', soak));
  check('REST error rate below 1%', soak.restErrorRate < 1, `${soak.restErrorRate}%`);
}

// 2. Realtime behaviour
check('no missed deliveries to always-connected probe sockets', soak.probeMissed === 0, `${soak.probeMissed} missed of ${soak.probeExpected} expected`);
check('no join failures', soak.joinFail === 0, `${soak.joinFail}`);
check('connection errors below 1% of connects', soak.connects === 0 || soak.connectErrors / (soak.connects + soak.connectErrors) < 0.01, `${soak.connectErrors} errors / ${soak.connects} connects`);

// 3. Server resources (needs the server log)
let resources = '';
if (args.server) {
  const stats = fs.readFileSync(args.server, 'utf8').split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((x) => x && x.message === 'server_stats').map((x) => ({ t: Date.parse(x.timestamp), ...x.meta }));
  if (stats.length < 6) {
    check('enough server_stats lines (>= 6) to judge resources', false, `${stats.length} found; set SOAK_STATS_INTERVAL_MS on the server`);
  } else {
    const third = Math.floor(stats.length / 3);
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const first = med(stats.slice(0, third).map((s) => s.rssMb));
    const last = med(stats.slice(-third).map((s) => s.rssMb));
    // least-squares slope over the second half (skip warm-up), MB per hour
    const half = stats.slice(Math.floor(stats.length / 2));
    const xs = half.map((s) => (s.t - half[0].t) / 3.6e6), ys = half.map((s) => s.rssMb);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    const slope = den ? xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / den : 0;
    const maxSockets = Math.max(...stats.map((s) => s.realtime?.sockets ?? 0));
    const endSockets = stats[stats.length - 1].realtime?.sockets ?? 0;
    const maxLoop = Math.max(...stats.map((s) => s.eventLoopP99Ms));
    // Memory trends need time: heap warm-up looks like a leak over a few minutes. Judge only long runs.
    const spanMin = (stats.at(-1).t - stats[0].t) / 60000;
    if (spanMin >= 10) check('RSS: last third median within 25% of first third', last <= first * 1.25, `${first} -> ${last} MB over ${Math.round(spanMin)} min`);
    else skip('RSS: last third median within 25% of first third', `SKIPPED, run is ${spanMin.toFixed(1)} min; needs >= 10`);
    if (spanMin >= 30) check('RSS slope in the second half below 20 MB/h', slope < 20, `${slope.toFixed(1)} MB/h`);
    else skip('RSS slope in the second half below 20 MB/h', `SKIPPED, run is ${spanMin.toFixed(1)} min; needs >= 30 (a short run mostly measures warm-up)`);
    if (soak.realtime) check('connected sockets fall back to 0 after the load stops (leave the server running ~1 min after the soak)', endSockets === 0, `${endSockets} at the last sample`);
    check('event-loop p99 delay stays below 100 ms', maxLoop < 100, `max ${maxLoop} ms`);
    check('open TCP sockets and in-flight work are bounded', stats.every((s) => s.inflight < 200), `max in-flight ${Math.max(...stats.map((s) => s.inflight))}`);
    resources = `\n- stats samples: ${stats.length} over ${Math.round((stats.at(-1).t - stats[0].t) / 60000)} min\n- RSS first-third median ${first} MB, last-third median ${last} MB, slope ${slope.toFixed(1)} MB/h\n- heapUsed last ${stats.at(-1).heapUsedMb} MB, external last ${stats.at(-1).externalMb} MB\n- max connected sockets ${maxSockets}, at the last sample ${endSockets} (after the load stops this must fall back to ~0; if not, sockets leak)\n- event-loop p99 max ${maxLoop} ms\n`;
  }
}

const table = rows.map((r, i) => `| ${r.join(' | ')} |${i === 0 ? '\n|' + r.map(() => '---').join('|') + '|' : ''}`).join('\n');
console.log(`### Soak result\n\n${table}\n\n- delivery (REST post -> socket event): p50 ${soak.delivery.p50} ms, p95 ${soak.delivery.p95} ms, p99 ${soak.delivery.p99} ms\n- sockets ${soak.sockets} (${soak.probes} probes), churn reconnects ${soak.connects - soak.sockets}, load ${soak.rate} msg/s for ${soak.durationS} s${resources}\n### Checks\n`);
for (const c of checks) console.log(`- ${c.skipped ? 'SKIPPED    ' : c.ok ? 'OK         ' : 'INVESTIGATE'}  ${c.name}  (${c.detail})`);
const bad = checks.filter((c) => !c.ok).length;
const skipped = checks.filter((c) => c.skipped).length;
console.log(`\n${bad ? `${bad} check(s) need a look` : 'all run checks OK'}${skipped ? `; ${skipped} skipped (run too short to judge)` : ''}`);
process.exit(bad ? 1 : 0);
