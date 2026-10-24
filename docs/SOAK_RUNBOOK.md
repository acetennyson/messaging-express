# Realtime soak runbook (Stage 5.4)

**Goal:** run `npm start` (the compiled `server.ts`, with `REALTIME_PROVIDER=socketio`) in staging for several days under production-like traffic and prove two things in writing before cutover (5.5):

1. REST behaves the same as plain `next start` (latency, error rate).
2. Nothing grows without bound (memory, sockets, in-flight work) and nothing is silently lost (every event reaches the clients that should get it).

Nothing here changes production. Staging only (the load script writes messages into the seeded conversation).

## 0. What you need

- A staging host that matches production (same Node version, same DB tier, same region as far as possible), able to run a long-lived process under a process manager.
- The seed fixtures loaded: `psql "$DATABASE_URL" -f scripts/smoke-seed.sql`.
- The same `JWT_SECRET` on the server and on the machine running the load script.
- `RATE_LIMIT_MODE` set deliberately: with `enforce` the load script will hit `429`s (counted as REST errors). Run the soak with `off` or `dry-run`, or raise the limits with `RATE_LIMITS_JSON`.

## 1. Baseline first (plain `next start` = `npm run nextstart`, REST only)

Same host, same data, same load, **no** realtime. This is what "equivalent" is measured against.

```bash
npm run build
npm run nextstart                                   # terminal 1 (sets NODE_ENV=production itself)
REALTIME=off DURATION_S=600 RATE=10 OUT=soak-baseline.jsonl \
  JWT_SECRET=... npm run soak                       # terminal 2
```

Use at least 10 minutes. Stop the server afterwards.

## 2. The soak (`npm start` with realtime)

```bash
npm run build
REALTIME_PROVIDER=socketio SOAK_STATS_INTERVAL_MS=60000 \
  npm start 2>&1 | tee server.log        # terminal 1, leave it running for days
```

`SOAK_STATS_INTERVAL_MS` makes the server log one `server_stats` line per interval: RSS, heap, external memory, open TCP sockets, in-flight work, event-loop delay, connected Socket.IO sockets and conversation rooms. `60000` (1 min) is right for multi-day runs; use `2000` for a short test.

Generate load. Run a heavier burst once, then a steady background load for the rest of the soak:

```bash
# burst (10 min): many sockets with churn
SOCKETS=200 PROBES=10 CHURN_PER_MIN=0.5 DURATION_S=600 RATE=20 OUT=soak-burst.jsonl JWT_SECRET=... npm run soak

# steady (repeat, e.g. from cron, or one long run): production-like
SOCKETS=50 PROBES=5 CHURN_PER_MIN=0.2 DURATION_S=3600 RATE=5 OUT=soak-steady-$(date +%F).jsonl JWT_SECRET=... npm run soak
```

`PROBES` are sockets that never reconnect; every message sent after they joined must reach every one of them. That is the missed-delivery check. The other sockets reconnect at random, which is the reconnect churn.

Also exercise a few things by hand at least once during the soak:

- `kill -TERM` the process under the process manager: clients reconnect, process exits 0, comes back.
- Restart the database connection (or the pooler) while sockets are connected: REST recovers, sockets stay up.
- Put it behind the real load balancer if there is one: confirm sticky sessions or websocket-only clients.

## 3. Daily checklist (5 minutes)

| Check | How | Worry if |
|---|---|---|
| REST error rate and latency vs baseline | `soak-*.jsonl` windows, or your platform's metrics | p95 > baseline +25%, or errors above baseline |
| Memory | `grep server_stats server.log \| tail` (`rssMb`, `heapUsedMb`, `externalMb`) | RSS keeps climbing day over day instead of plateauing |
| Sockets | `openTcpSockets`, `realtime.sockets` | stays high after the load stops (leak), or open TCP sockets far above Socket.IO sockets |
| Conversation rooms | `realtime.conversationRooms` | grows without a matching number of active conversations |
| In-flight work | `inflight` | stays above 0 for minutes at a time (stuck webhook/realtime work) |
| Event loop | `eventLoopP99Ms` | regularly above ~100 ms |
| Restarts | process manager restart count, `uncaught_exception` / `unhandled_rejection` in the log | any unexplained restart |
| Errors in the log | `realtime_publish_failed`, `realtime_join_failed`, `shutdown_forced`, `request_handler_failed` | any, in volume |
| Missed deliveries | `probeMissed` in each soak summary | anything above 0 |

## 4. Summarise

```bash
node scripts/soak/summarize.mjs --soak soak-burst.jsonl --server server.log --baseline soak-baseline.jsonl
# or: npm run soak:summary -- --soak ... --server ... --baseline ...
```

It prints a Markdown block and an `OK / INVESTIGATE` verdict per check. Keep the server running for about a minute after the load script finishes, so the last `server_stats` line shows the sockets falling back to 0.

Heuristics (they are judgement aids, adjust with a reason): REST p95 within 25% (+15 ms) of baseline; error rate not above baseline; zero missed deliveries; connection errors below 1%; RSS last-third median within 25% of the first third (only judged for runs of 10 min or more); RSS slope below 20 MB/h (only judged for runs of 30 min or more, because a short run mostly measures warm-up); event-loop p99 below 100 ms; sockets back to 0 after the load.

## 5. Done when: the written note

Paste into the PR/issue for 5.4. Do not tick the stage without all of it.

```
Soak note: realtime path A (D1)
Environment: <host, Node version, DB tier, region, load balancer yes/no>
Duration: <start> to <end> (<N> days)
Load: burst <sockets/rate/duration>, steady <sockets/rate/duration>

REST equivalence (npm start vs next start, same load):
  p50/p95/p99: <...> vs <...>        error rate: <..>% vs <..>%

Realtime:
  messages sent <N>, probe deliveries expected <N>, missed <N>
  connection errors <N> of <N> connects; join failures <N>
  delivery latency (REST post -> socket) p50/p95/p99: <...>

Resources (from server_stats):
  RSS first day median <..> MB -> last day median <..> MB (slope <..> MB/h)
  max sockets <..>, sockets after load <..>; max in-flight <..>; event-loop p99 max <..> ms

Incidents: <restarts, errors, manual tests (SIGTERM, DB restart, LB) and their outcome>
Conclusion: REST behaviour is equivalent / not equivalent because <...>.
            No resource growth observed / growth in <...> needs <...>.
Decision: proceed to cutover (5.5) / fix first: <...>
```

## 6. If something looks wrong

- **RSS climbs steadily:** compare `heapUsedMb` and `externalMb`. Heap growing: a JS leak (look at per-socket state and timers in `lib/realtime/providers/socketio.ts`); external growing: buffers, sockets. Take a heap snapshot (`node --heapsnapshot-signal=SIGUSR2 dist/server.js`, then `kill -USR2 <pid>`) at two points and compare.
- **Sockets stay high after load:** clients that vanished without closing. Check the load balancer's idle timeout against Socket.IO's ping settings, and count `openTcpSockets` against `realtime.sockets`.
- **Missed deliveries:** check `realtime_publish_failed` and whether more than one instance is running without `REDIS_URL` (`realtime_adapter` = `memory` means events never cross instances).
- **REST slower than baseline:** `server.ts` and the routes use separate DB pools; check the total connection count against the database limit.
