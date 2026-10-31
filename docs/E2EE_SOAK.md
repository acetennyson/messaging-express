# E2EE soak and rollout runbook (Stage 7.9)

Goal: run the E2EE server code in staging for several days, with the flag on, and prove in writing that the rules hold and nothing grows or breaks, before enabling it anywhere that matters. Staging only: the scripts create users, devices, conversations and messages (named `soak-e2ee-*`).

Add these to `package.json` `scripts` (I do not edit it for you):

```json
"soak:e2ee": "node scripts/soak/soak-e2ee.mjs",
"soak:e2ee:forever": "node scripts/soak/soak-e2ee-forever.mjs",
"soak:e2ee:report": "node scripts/soak/e2ee-log-report.mjs"
```

## 0. What the scripts are

| Script | What it does |
|---|---|
| `npm run verify:e2ee` | One-shot behaviour check of every stage (run it first, in both flag states). |
| `scripts/soak/soak-e2ee.mjs` | Continuous mix of encrypted traffic against a running server, **checking the rules as it goes** and exiting non-zero on any violation. Synthetic keys and ciphertext (the server cannot tell), so it works before `client-crypto` exists. |
| `scripts/soak/soak-e2ee-forever.mjs` | Runs the above in back-to-back chunks (default 1 h), one JSONL file per chunk, optional alert webhook. This is the "persistent" runner: put it under pm2, systemd or a terminal. |
| `scripts/soak/e2ee-log-report.mjs` | Reads the server log: error-level lines, `rate_limit_would_block` per route group, memory trend. |
| `node scripts/smoke-e2ee.mjs` | Response-shape baselines for the E2EE routes (`scripts/baselines-e2ee/`), flag on. Run after every deploy; the original `scripts/smoke.sh` must still pass with the flag off **and** on. |
| `scripts/soak/soak.mjs` | The existing realtime/REST soak (Stage 5.4); keep running it alongside. |

What `soak-e2ee.mjs` asserts: valid ciphertext at the latest key version is accepted and plaintext refused; after a member is removed the old key version gets `409 KEY_ROTATION_REQUIRED`, a new version including the removed user's device gets `409 STALE_DEVICE_SET`, and the remaining members can rotate; a re-added member can be given the current key; pair/link/revoke cycles; key requests; backup round-trips byte-exact; encrypted-attachment upload works only with `category=e2ee`; and **every realtime event reaches exactly the users it should** (missed, duplicate and leaked events are counted, and a user who shares no conversation must hear nothing).

It does **not** test real cryptography. That is `client-crypto`'s own test suite and the two-real-clients run in section 3.

## 1. Start

Server (staging, same Node, DB tier and region as production as far as possible):

```bash
npm run db:migrate
npm run build
E2EE_ENABLED=on REALTIME_PROVIDER=socketio SOAK_STATS_INTERVAL_MS=60000 RATE_LIMIT_MODE=dry-run \
  npm start 2>&1 | tee server.log
```

`RATE_LIMIT_MODE=dry-run` logs `rate_limit_would_block` instead of blocking, which is what section 2 watches. Use `off` if you do not want that signal.

Soak (another machine or terminal; same `JWT_SECRET` as the server):

```bash
JWT_SECRET=... BASE_URL=https://staging.example.com DURATION_S=300 npm run soak:e2ee     # 5 min smoke run first
JWT_SECRET=... BASE_URL=https://staging.example.com ALERT_WEBHOOK_URL=... npm run soak:e2ee:forever   # then leave it
```

Windows (cmd): `set JWT_SECRET=...&& set BASE_URL=...&& npm run soak:e2ee`. PowerShell: `$env:JWT_SECRET="..."`.

Knobs: `GROUPS` (3), `OPS_PER_SEC` (2), `EVENT_WAIT_MS` (10000), `CHUNK_S` (3600), `FAIL_FAST=on`. See the header of each script.

**The server must run with realtime on** (`REALTIME_PROVIDER=socketio`, i.e. `npm run dev:socket` or `server.ts`), not plain `next dev`, or every event shows up as missed.

**Outages are not violations.** The soak probes `HEALTH_PATH` (`/api/health`) every 2 s. If the server stops answering it pauses, voids the events in flight (`voided`, never `missed`), rebuilds its groups when the server is back, and records the outage in the summary (`outages`, `outageSeconds`, `outageLog`). After `OUTAGE_ABORT_S` (300) seconds down it stops with exit code 3. Exit codes: 0 clean, 1 a rule broke, 2 setup failed, 3 server unreachable. The forever wrapper backs off (30 s doubling to 10 min) on 2 and 3 and sends ONE alert per outage plus one on recovery; only exit 1 alerts every time.

**Slow environments** (remote DB, Upstash at 1-2.5 s per request): set `EVENT_WAIT_MS=30000`, and expect `rate_limit_check_failed` (the rate-limit check times out at 250 ms and fails open). For a pure protocol soak you can run the staging server with `RATE_LIMIT_MODE=off`. A server crash (exit 1, `uncaught_exception`) is a server bug to fix, not a soak result.

## 2. Daily check (5 minutes)

| Check | How | Worry if |
|---|---|---|
| Chunks clean | `cat soak-e2ee-runs/chunks.log` | any `FAILED`. Open that chunk's JSONL: the last line has `firstProblems`. |
| Events delivered | summary line: `matched` vs `expected` | any `missed`, `unexpected` or a stranger event |
| Latency | window lines: `lat` per route group, p95 | p95 climbing day over day |
| Server errors | `npm run soak:e2ee:report -- server.log --since <yesterday>` | `INVESTIGATE` |
| Rate limits | same report, `rate_limit_would_block` | any hit on an E2EE group (`devices`, `devices/pair`, `devices/link`, `devices/backup`, `conversations/keys/request`) |
| Memory/sockets | `server_stats` lines | RSS or socket count rising steadily instead of flattening |

Pass bar before moving on: 3 consecutive days of clean chunks, zero missed/unexpected events, no E2EE-group `would_block`, flat memory.

## 3. Things only a person can do

- Run the `client-crypto` integration suite against staging with **two real clients** (different devices or browsers) for several days: send, receive, add and remove members, link a device, restore from backup. This is the only check of real crypto against the real server.
- `kill -TERM` the server under the process manager mid-soak: clients reconnect, the next chunk is clean.
- Restart the database connection or pooler mid-soak: REST recovers.
- Read `ARCHITECTURE.md` (threat model) with fresh eyes: does it say what the server can and cannot see?

## 4. Production

1. Run `npm run db:migrate` in production and verify it **before** enabling anything (the message check reads the new columns).
2. Enable `E2EE_ENABLED=on` for one environment in a low-traffic window. Watch error rates on the E2EE routes and `rate_limit_would_block` for an hour.
3. Keep `npm run verify:e2ee` and the smoke script available; both pass in either flag state.

## 5. Rollback: read this before enabling in production

`E2EE_ENABLED=off` hides the new routes immediately. **It does not protect existing encrypted conversations:** with the flag off, `POST /messages` is the original code and does not look at `encryption_mode`, so plaintext sent into an encrypted conversation is accepted and stored, and key-version rules are no longer checked. Clients built on `client-crypto` keep sending ciphertext, but nothing enforces it. If production has live encrypted users, tell customers before turning the flag off, and prefer fixing forward.

Recovery for a user who lost every device: the customer's backend calls `POST /users/:userId/devices/reset` with an admin or API token; the user registers a fresh device and (if they have one) restores the key backup.
