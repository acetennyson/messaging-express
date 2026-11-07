# Load testing and soak tests

Before you trust a deployment with real traffic, run it under load for a while and check that latency stays flat, memory stops growing, and no realtime message is lost. The repo includes a load generator and a summarizer.

Run these against **staging**: the load script writes real users, conversations and messages.

## What you need

- A staging host like production (same Node version, database tier and region where possible), running `npm start` with `REALTIME_PROVIDER=socketio`.
- Seed data: `psql "$DATABASE_URL" -f scripts/smoke-seed.sql`.
- The same `JWT_SECRET` on the server and on the machine running the load script.
- `RATE_LIMIT_MODE` set on purpose. With `enforce` the script hits `429`s, which count as errors. Use `off` or `dry-run`, or raise limits with `RATE_LIMITS_JSON`.

## 1. Baseline

Same host, same data, same load, **without** realtime. This is what "no slower" is measured against.

```bash
npm run build
npm run nextstart                                              # terminal 1
REALTIME=off DURATION_S=600 RATE=10 OUT=soak-baseline.jsonl JWT_SECRET=... npm run soak   # terminal 2
```

Run at least 10 minutes, then stop the server.

## 2. The soak

```bash
REALTIME_PROVIDER=socketio SOAK_STATS_INTERVAL_MS=60000 npm start 2>&1 | tee server.log
```

`SOAK_STATS_INTERVAL_MS` makes the server log a `server_stats` line each interval: memory (`rssMb`, `heapUsedMb`, `externalMb`), open TCP sockets, in-flight work, event-loop delay, connected Socket.IO sockets and conversation rooms. Use `60000` for multi-day runs and `2000` for a quick test.

Generate load from another terminal:

```bash
# burst, 10 minutes, lots of sockets with churn
SOCKETS=200 PROBES=10 CHURN_PER_MIN=0.5 DURATION_S=600 RATE=20 OUT=soak-burst.jsonl JWT_SECRET=... npm run soak

# steady background load
SOCKETS=50 PROBES=5 CHURN_PER_MIN=0.2 DURATION_S=3600 RATE=5 OUT=soak-steady.jsonl JWT_SECRET=... npm run soak
```

| Variable | Meaning |
|---|---|
| `SOCKETS` | Number of Socket.IO clients |
| `PROBES` | Sockets that never reconnect. Every message sent after they joined must reach every probe: this is the missed-delivery check |
| `CHURN_PER_MIN` | Reconnect rate of the other sockets |
| `RATE` | Messages per second sent over REST |
| `DURATION_S` | Run time |
| `OUT` | Result file (JSON lines) |
| `BASE_URL` | Server to test (default `http://localhost:3000`) |
| `PROJECT_ID`, `ORGANIZATION_ID`, `CONVERSATION_ID`, `SENDER_ID`, `OTHER_USER_ID` | Fixtures; default to the ones in `scripts/smoke-seed.sql` |

Also try by hand at least once: `kill -TERM` the process (clients should reconnect, exit code 0), restart the database connection while sockets are connected (REST recovers, sockets stay), and test through the real load balancer.

## 3. Daily checks

| Check | Look at | Worry if |
|---|---|---|
| REST latency, errors | `soak-*.jsonl` vs baseline | p95 more than 25% above baseline, or more errors |
| Memory | `server_stats` `rssMb` | keeps climbing day after day instead of leveling off |
| Sockets | `realtime.sockets`, `openTcpSockets` | stays high after load stops |
| Rooms | `realtime.conversationRooms` | grows without matching active conversations |
| In-flight work | `inflight` | above 0 for minutes |
| Event loop | `eventLoopP99Ms` | regularly above about 100 ms |
| Restarts and crashes | process manager, `uncaught_exception` in log | any unexplained |
| Realtime errors | `realtime_publish_failed`, `realtime_join_failed`, `shutdown_forced` | any in volume |
| Missed deliveries | `probeMissed` | anything above 0 |

## 4. Summarize

```bash
npm run soak:summary -- --soak soak-burst.jsonl --server server.log --baseline soak-baseline.jsonl
```

Prints a Markdown report and an `OK` or `INVESTIGATE` verdict per check. Keep the server running about a minute after the load stops so the last stats line shows sockets back at 0.

## If something looks wrong

- **Memory climbs:** compare `heapUsedMb` and `externalMb`. Heap growth is a JavaScript leak; external is buffers and sockets. Take heap snapshots at two points (`node --heapsnapshot-signal=SIGUSR2 dist/server.js`, then `kill -USR2 <pid>`) and compare.
- **Sockets stay high:** clients vanished without closing. Compare the load balancer's idle timeout with Socket.IO's ping settings.
- **Missed deliveries:** check `realtime_publish_failed`, and whether several instances run without `REDIS_URL` (`realtime_adapter` shows `memory`).
- **REST slower than baseline:** check the total database connection count across instances.

## Encryption soak

With `E2EE_ENABLED=on`, `scripts/soak/soak-e2ee.mjs` drives a running server with a continuous mix of encrypted-conversation traffic and **checks the rules** while doing it. It is a protocol soak, not a crypto one: it uses synthetic keys and ciphertext, so it needs no client library.

```bash
JWT_SECRET=... node scripts/soak/soak-e2ee.mjs                                  # 60 second smoke run
JWT_SECRET=... DURATION_S=0 OUT=soak-e2ee.jsonl node scripts/soak/soak-e2ee.mjs   # until stopped (Ctrl+C or SIGTERM)
```

Variables: `BASE_URL`, `JWT_SECRET` (required), `DURATION_S` (default 60; 0 = forever), `GROUPS` (encrypted conversations of 3 users, default 3), `OPS_PER_SEC` (default 2), `EVENT_WAIT_MS` (how late a realtime event may be before it counts as missed, default 10000), `FAIL_FAST` (exit 1 at the first broken rule), `OUTAGE_ABORT_S` (stop if the server is unreachable that long, default 300), `HEALTH_PATH` and `OUT`.

It asserts that valid ciphertext at the latest key version is accepted and plaintext is refused, that after a member is removed the old key version is refused (`409 KEY_ROTATION_REQUIRED`), and that device, key and membership events reach exactly the users they should and nobody else. `soak-e2ee-forever.mjs` runs it in back-to-back chunks (`CHUNK_S`, default 3600, one file per chunk in `OUT_DIR`) and can POST `{text}` to `ALERT_WEBHOOK_URL` after a failed chunk. `e2ee-log-report.mjs <server.log>` reads the server log and reports error lines from encryption code paths and rate-limit would-blocks; it exits 1 when it finds any, so it suits cron or CI.
