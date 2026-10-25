# Engineering Log: Zero-downtime realtime rollout (Stages 4.4 to 5.6)

Messaging-express: Next.js 16 + Postgres, multi-tenant Messaging-as-a-Service (tables prefixed `mx_`).
This is a findings log: what was built, in what order, what broke, why, and how it was fixed. It is written
for a future maintainer (or interviewer) who needs the reasoning, not just the diff. Plan of record:
`IMPLEMENTATION_PLAN.md` (v3, staged, zero-downtime) and `REDESIGN.md`.

**Working method.** Every stage or sub-stage is a GitHub issue; every solution is a PR. Before starting the next
stage, the PR title and description for the finished one is written up. Each stage ships behind a flag or a
parallel entrypoint so it can be rolled back without a deploy.

---

## 1. Outcome at a glance

| Stage | Delivered | Flag / switch | Rollback |
|---|---|---|---|
| 4.3 | Webhook dispatch verified end to end (`scripts/test-webhooks.sh`) | `WEBHOOK_DISPATCH` | flag off |
| 4.4 | Webhook retries: backoff 1m/5m/30m/2h (5 attempts), claim-with-lease, internal retry endpoint | `WEBHOOK_RETRY`, `CRON_SECRET` | `WEBHOOK_RETRY=off` |
| 5.0 | Decision D1: realtime **Path A** (Socket.IO inside the Next process). Paths B (separate service + Redis) and C (hosted provider) kept for later branches | n/a | n/a |
| 5.1 | Realtime registry (`registerRealtime/getRealtime/publishRealtime`), `emitEvent` realtime branch | `REALTIME_PROVIDER=none` | default is none |
| 5.2 | Custom `server.ts` entrypoint, graceful shutdown, in-flight tracking | `npm run start:socket` (parallel) | keep using `next start` |
| 5.3 | Socket.IO provider: JWT handshake, rooms, join ack codes, join rate limit, token expiry | `REALTIME_PROVIDER=socketio` | set `none` |
| 5.4 | Soak tooling and runbook (`scripts/soak/*`, `docs/SOAK_RUNBOOK.md`) | n/a | n/a |
| 5.5 | Cutover: `npm start` runs the compiled server; `npm run nextstart` keeps plain `next start` | script choice | `npm run nextstart` |
| 5.6 | Redis adapter for multi-instance fan-out | `REDIS_URL` | unset it |
| H1-H4 | Pool no longer exits the process; correct 401/404/500 codes; optional project cache | `PROJECT_CACHE_TTL_SECONDS` | revert / unset |
| 6 | Docs match the code (SDK parts pending) | n/a | n/a |
| API errors | Correct status codes on every route; participants must belong to the project | n/a | revert |

Final verification of 5.6: `tsc` clean; 72 tests in 11 files pass; live two-instance run passes locally and
against Upstash (see section 6).

---

## 2. Architecture decisions

### 2.1 Why Path A first
Socket.IO needs a long-running Node process. A custom `server.ts` wraps the Next request handler and attaches
Socket.IO to the same HTTP server. This is the cheapest path (one deploy, no extra infra) and shares auth with REST.
Paths B and C are not wasted: the **client contract is identical in all three**, so the SDK does not care.

### 2.2 Wire contract (stable across paths)
- Handshake: `auth: { token }` (the same JWT used for REST).
- Client to server: `join-conversation` / `leave-conversation`, with acks. Ack error codes:
  `INVALID_PAYLOAD | FORBIDDEN | RATE_LIMITED | INTERNAL_ERROR`.
- Connect errors carry `err.data.code`: `AUTH_REQUIRED | INVALID_TOKEN | PROJECT_INACTIVE`.
- Rooms: `conversation:<id>`. Events are emitted under their own name (`message.created`).
- Join limiter: 20 joins per 10 s. Sockets are disconnected when their token expires.

### 2.3 Shared state must live on `globalThis`
Next bundles each route separately from `server.ts`, so a module-level variable is **not** shared between the
server entrypoint and a route handler. The realtime registry and the in-flight tracker are stored on
`globalThis[Symbol.for('messaging-express.realtime')]` (and an equivalent for in-flight). Without this,
`registerRealtime()` in `server.ts` is invisible to `emitEvent()` in a route.

### 2.4 Feature flags
Flags are read **at request time** via `getEnumFlag` with exact values (`on`, `off`, ...), so they can be flipped
without a deploy. Exceptions read at **boot**: `REALTIME_PROVIDER`, `REDIS_URL`.

### 2.5 Delivery semantics
- Webhooks: at-least-once, HMAC-SHA256 in `X-Webhook-Signature`. Retries use
  `FOR UPDATE SKIP LOCKED` with a 120 s lease so two workers never take the same row.
- Realtime: best effort. Publishing happens after the response (`after()` with a detached-promise fallback), tracked
  as in-flight work so shutdown can drain it.

---

## 3. Stage notes

### 3.1 Webhook retries (4.4)
`lib/webhooks/{backoff,sender,retry}.ts`, `app/api/internal/webhooks/retry/route.ts`.
- `nextRetryDelayMs(attemptsMade)` returns the delay, or null after `MAX_ATTEMPTS=5`.
- The retry route accepts POST and GET, requires `Authorization: Bearer $CRON_SECRET` (timing-safe compare), returns
  503 when `CRON_SECRET` is unset, and `{data:{skipped:true}}` when `WEBHOOK_RETRY` is off.
- If an organization removed its webhook URL between attempts, the row is marked "gave up" instead of retried.
- Concurrency inside a batch is bounded (`mapWithConcurrency`, 5); batch size from `WEBHOOK_RETRY_BATCH`.

### 3.2 Realtime registry and entrypoint (5.1, 5.2)
- `RealtimeProvider { publish; close?(); stats?() }`.
- `emitEvent` has two branches: webhook and realtime. Both go through one `schedule()` helper.
- `server.ts`: dev/prod detection, `server_listening` log, `server_stats` interval log, and a shutdown order of
  stop accepting, drain in-flight, close realtime, destroy remaining sockets, close Next, exit. Uncaught exceptions
  and unhandled rejections are fatal (exit 1) by design, which matters for 5.6 (section 5.9).

### 3.3 Socket.IO provider (5.3)
`lib/realtime/providers/socketio.ts`. 11 tests against a real DB and real sockets. Auth reuses `loadActiveProject`
(extracted from the REST middleware so both paths enforce the same "project is active" rule).

### 3.4 Soak and cutover (5.4, 5.5)
- Soak: `scripts/soak/soak.mjs` holds N sockets and posts messages; `summarize.mjs` reads the `server_stats` lines.
  The multi-day staging soak and its written note are an **operator task, not yet done**.
- Cutover: `npm start` now runs `node dist/server.js`; `npm run nextstart` is the escape hatch to plain `next start`.
  `npm run build` runs `next build && npm run build:server`.

### 3.5 Redis adapter (5.6)
`lib/realtime/providers/redis.ts`, `attachRedisAdapter(io, url)`:
- Two ioredis clients (pub, sub). Pub: `enableOfflineQueue:false`, `maxRetriesPerRequest:1`. Sub:
  `enableOfflineQueue:true`, `maxRetriesPerRequest:null` (it must resubscribe after reconnect).
- Boot waits up to 3 s for readiness, then **serves anyway** and logs `redis_not_ready_at_boot`.
- Adapter commands are fire-and-forget, so they are wrapped in `guard()`: failures log `redis_command_failed`
  instead of becoming unhandled rejections.
- `close()` races `quit()` against 1 s, then `disconnect()`.
- Instance shutdown uses `io.local.disconnectSockets(true)` so stopping instance A does not disconnect clients on B.

---

## 4. Test inventory

| Area | File | Notes |
|---|---|---|
| Backoff | `lib/webhooks/backoff.test.ts` | pure |
| Retry | `lib/webhooks/retry.test.ts` | real Postgres |
| Retry route | `app/api/internal/webhooks/retry/route.test.ts` | auth, 503, skipped |
| Emit | `lib/events/emit.test.ts` | webhook + realtime branches |
| In-flight | `lib/events/inflight.test.ts` | drain/timeout |
| Registry | `lib/realtime/index.test.ts` | |
| Socket.IO | `lib/realtime/providers/socketio.test.ts` | 11 tests, real DB + sockets |
| Redis | `lib/realtime/providers/redis.test.ts` | 6 tests, gated by `REDIS_URL` |
| Flags | `lib/config/flags.test.ts` | |

Shell/Node scripts: `scripts/smoke.sh` (REST contract + response-shape baselines), `scripts/test-webhooks.sh`,
`scripts/test-realtime.mjs` (single instance), `scripts/test-realtime-cluster.mjs` (two instances).

---

## 5. Problems met and how they were solved

Each entry: **Symptom, Cause, Fix, Lesson.**

### 5.1 `test-webhooks.sh` section B failing (4.3)
- **Symptom:** Section A passed, B failed.
- **Cause:** A stale listener from a previous run still held port 9400, so the new run talked to the old process.
- **Fix:** The script now checks the port is free and that its own listener is alive; `LISTENER_PORT` overrides the port.
- **Lesson:** A test that binds a port must verify it owns it.

### 5.2 smoke.sh: 30 to 32 checks failing
- **Symptom:** Shape checks failed on list endpoints.
- **Cause:** Baselines recorded array shapes from whatever data existed at the time, so they were data dependent.
- **Fix:** Shapes are merged across array elements (`SHAPE_JQ`). Baselines must be re-recorded with `--record` after any shape change.
- **Lesson:** Record structure, never data.

### 5.3 Misleading 401s with the database down
- **Symptom:** Everything returned 401.
- **Cause:** The sandbox Postgres stopped between calls; the auth layer's catch-all turned the DB error into 401.
- **Fix:** Restart Postgres (`pg_ctlcluster 16 main start`). Noted as a diagnostic trap rather than changed behaviour.
- **Lesson:** When everything is 401, check the database before the token.

### 5.4 `pkill -f` killed the working shell (exit 144)
- **Fix:** Kill by pid or `fuser -k`. **Lesson:** Never pattern-kill from a shell whose own command line matches.

### 5.5 `npm run start:socket` MODULE_NOT_FOUND
- **Cause:** `dist/` did not exist; the compiled server must be built first.
- **Fix:** `npm run build:server` (or `npm run build`). Documented in the README.

### 5.6 `next build` failed: `export const dynamic` with Cache Components
- **Cause:** With `cacheComponents` enabled Next forbids route segment config `dynamic`. This was an error of mine in the retry route.
- **Fix:** Removed it. A second build error in `app/uploads/[...path]/route.ts` (`Buffer` is not a `BodyInit`) was fixed with `new Uint8Array(data)`.
- **Lesson:** `next build` is part of per-stage verification, not only `tsc` and tests.

### 5.7 Type errors in `jwt.ts` and `server.ts`
- Type-only fixes in `jwt.ts`; `NODE_ENV` is read-only in the types, so it is set through a `Record<string,string|undefined>` cast.

### 5.8 Shutdown hang (12 s forced exit)
- **Symptom:** SIGTERM took the full forced-exit timeout when an upgrade socket was never answered.
- **Cause:** `io.close()` resolves only when the HTTP server has closed, which waits for those sockets. We were awaiting it.
- **Fix:** Do not await `io.close()` indefinitely (race with 250 ms); track raw sockets and destroy them; `closeAllConnections()`.

### 5.9 Next dev HMR "socket hang up" with Socket.IO
- **Cause:** engine.io destroyed upgrade requests it did not own, including Next's HMR upgrades.
- **Fix:** `destroyUpgrade:false`. A browser check on `dev:socket` is still outstanding.

### 5.10 `test-realtime.mjs` failing on a slow database
- **Symptom:** Two delivery checks failed on the author's machine.
- **Cause:** The wait timer started before the REST POST returned; with a slow DB the POST ate the whole window.
- **Fix:** Record events continuously and start waiting only after REST returns. Reproduced with a `pg_sleep` trigger.

### 5.11 Redis test failures (5.6), four distinct causes
1. Missing `JWT_SECRET`/`DATABASE_URL` at import: `vi.hoisted` placeholders.
2. `socket.join(...).then` on a void return: use `await`.
3. Unhandled rejections from adapter `unsubscribe/punsubscribe` while Redis is down: `guard()` wrappers.
4. `quit()` hangs on an unreachable Redis: bounded 1 s race then `disconnect()`.

### 5.12 Windows: `npm run build` could not find `ioredis`
- **Symptom:** `TS2307: Cannot find module 'ioredis'`.
- **Cause:** New dependencies were in `package.json` but `npm install` had not been run after unzipping.
- **Fix:** `npm install`. Not a code bug.

### 5.13 Upstash: endless `redis_reconnecting`
- **Symptom:** `redis_reconnecting` every ~10 s for both clients, never `redis_ready`; boot logged
  `redis_not_ready_at_boot` and then served anyway; one publish logged `redis_command_failed`
  ("Stream isn't writeable and enableOfflineQueue options is false").
- **Cause:** `REDIS_URL` used `redis://`. Upstash accepts only TLS, so ioredis spoke plaintext to a TLS port and
  the server dropped the connection.
- **Fix:** Use `rediss://` (two s). After that: `redis_ready` for pub and sub, `realtime_adapter: redis`.
- **What this validated:** the degraded path works in the real world. REST kept returning 201, the process stayed
  up, and only cross-instance delivery was lost while Redis was unreachable.
- **Open polish:** `redis_command_failed` logs a full stack at `error` level for an outage the server handles by
  design. Planned: one-line throttled `warn`.

### 5.14 Running the cluster script (operator mistakes, recorded because they recur on Windows)
- `bash scripts/test-realtime-cluster.mjs`: it is a Node script, run `node`.
- `JWT_SECRET=... node ...` in `cmd`: not supported, use `set JWT_SECRET=...` on its own line.
- `set JWT_SECRET='...'`: in `cmd` the quotes become part of the value, so the token was signed with a different
  secret and the server answered `INVALID_TOKEN`. Use no quotes.

### 5.15 Track H1: idle DB client error killed the whole server
- **Symptom (latent):** `lib/db/pool.ts` called `process.exit(-1)` on any pool `error` event, so one dropped idle
  connection (database restart, failover, network blip) stopped the process. Under the custom server that also
  disconnects every open socket.
- **Fix:** log `db_pool_idle_client_error` and carry on; `pg` discards the broken client and the next query opens a
  new connection. Test: `lib/db/pool.test.ts`.
- **Verified live:** with the server running, all backend connections were terminated with `pg_terminate_backend`;
  the process stayed up, logged the error once, and the next requests returned 200.

### 5.16 Track H2 and H3: wrong status codes
- **Symptom (seen during debugging, 5.3):** with the database down every request returned `401`, which sent the
  investigation to tokens instead of the database. In `POST /messages` a missing conversation and a database failure
  were both `400`, and internal error text (connection details) went to the client.
- **Cause:** `requireAuth` ran authentication, rate limiting and the handler in one `try`, and its `catch` always
  answered 401. `handlePOST` answered every error with `validationError`.
- **Fix:** typed errors in `lib/errors.ts` (`AuthError` 401, `NotFoundError` 404, `RequestValidationError` 400) and
  one mapper, `toErrorResponse`. Authentication has its own `try` (only `AuthError` is a 401); everything else, including
  handler exceptions, becomes `500 INTERNAL_ERROR` with a generic message and a server-side log.
  Zod and malformed-JSON errors stay 400. The 401 body is byte-identical to before.
- **Verified live:** unknown conversation 404; malformed JSON 400; token failures still 401; with Postgres stopped a
  request that used to be 401 is now 500, and requests recover when Postgres returns.
- **Left alone on purpose:** other routes and `GET /messages` (same pattern, follow-up PR), and the realtime
  handshake, which still reports a database error as `PROJECT_INACTIVE` (changing connect error codes touches the
  wire contract).

### 5.17 Track H4: project lookup on every request
- **Situation:** `authenticateRequest` (and the realtime handshake) queried Postgres for the project on every call.
- **Change:** an optional cache in `lib/auth/project.ts`, controlled by `PROJECT_CACHE_TTL_SECONDS` (1..3600,
  unset/0 = off, read per call so it changes without a restart). Only successful lookups are cached; failures never are,
  so reactivation is immediate. Bounded to 1000 entries, callers get copies.
- **Trade-off, measured live:** with TTL=3, deactivating the project in the database still returned 200 immediately
  after, 401 once the TTL passed, and 200 again right after reactivation. With TTL unset, deactivation is immediate.
- **Why off by default:** it is a deliberate loosening of "deactivate means now"; the operator opts in.
- **Not covered:** each instance and each bundle keeps its own cache, so there is no cross-instance invalidation.
- **Gotcha while testing:** two dev servers on one port gave misleading results; check the port is free first.

### 5.18 Stage 6: documentation caught up with the code
- **Problem:** the docs described a system that no longer existed: `ARCHITECTURE.md` called WebSockets "(Planned)" and
  referenced `mediaUploadService.ts`; `PROJECT_SUMMARY.md` listed rate limiting and webhook retries as future work;
  the README claimed features that are only database tables (reactions, typing, read receipts, edit/delete, API keys,
  per-project CORS, analytics, request ids).
- **Done:** deleted `lib/services/mediaUploadService.ts` (grep first: only comments and docs referred to it);
  rewrote `ARCHITECTURE.md` from the code; updated `PROJECT_SUMMARY.md`, `SETUP_GUIDE.md` (new deployment section: run
  modes, sticky sessions, Redis, retry cron, storage limits), `API_EXAMPLES.md` (REST upload example, 500 error) and the
  README feature list (legend: works / schema only / planned).
- **Left for after the SDK:** `client.uploads` example, `packages/` in the structure, deleting `lib/client/`.
- **Lesson:** claims in docs need the same review as code; "schema exists" is not "feature exists".

### 5.19 Error-contract cleanup for the remaining routes, and a tenancy gap found on the way
- **Scope:** `GET /users`, `POST /users`, `GET /conversations`, `POST /conversations`, `GET /messages` now use
  `toErrorResponse` (5.16). The two upload routes already return correct codes and were left alone.
- **Regression caught by a test:** `GET /users?limit=abc` used to reach Postgres (`LIMIT NaN`) and come back as a 400 only
  because every error was a 400. With correct codes it would have become a 500, so the route now validates its query
  (`userQuerySchema`, same bounds as the other list routes: `limit` 1 to 200).
- **Tenancy gap (security):** `POST /conversations` inserted participants without checking they belong to the project. A
  user id from another project passed the foreign key and was added (reproduced: 201). Fixed with a check inside the
  transaction; duplicates are rejected up front. Found because writing the test for "unknown participant" forced a look at
  what the route actually verified.
- **Postgres errors:** FK violation is a 400 and unique violation a 409, with no constraint or table names in the response.
- **Existing data:** conversations created before the fix may contain foreign participants. To list them:
  `SELECT cp.conversation_id, cp.user_id FROM mx_conversation_participants cp JOIN mx_conversations c ON c.id = cp.conversation_id JOIN mx_users u ON u.id = cp.user_id WHERE u.project_id <> c.project_id;`
- **Lesson:** when every error returns the same status, some code is quietly relying on it. Test the input that used to "work by accident".

---

## 6. Verification evidence

### 6.1 Local live run (two real `dist/server.js` instances, one local Redis)
| Scenario | Result |
|---|---|
| No Redis, two instances | Cross-instance delivery **fails** both directions (the bug 5.6 fixes) |
| Redis on both | POST to B reaches client on A, and POST to A reaches client on B; each client got exactly one copy |
| Redis killed | `POST /messages` still 201; both `/api/health` 200; both processes alive |
| Redis restarted | Cross-instance delivery returned with no app restart |
| SIGTERM instance A | Client on B stayed connected; A exited 0 |
| SIGTERM B while Redis down | Exit 0 in about 1 s, no unhandled rejection |

### 6.2 Against Upstash (the author's machine, Windows)
Boot log after the `rediss://` fix:

```
redis_ready          {"client":"pub", ...upstash.io:6379}
redis_ready          {"client":"sub", ...upstash.io:6379}
realtime_adapter     {"adapter":"redis"}
server_listening     {"url":"http://0.0.0.0:3000","dev":false,"realtime":"socketio"}
```

`node scripts/test-realtime-cluster.mjs` with instances on 3000 and 3001:

```
PASS client is connected and joined on each instance
PASS POST to B -> 201
PASS client on instance A received the event published by instance B
PASS client on instance B (same instance as the POST) received it too
PASS each client received it exactly once (no duplicates)
PASS POST to A -> 201
PASS client on instance B received the event published by instance A
PASS client on instance A received it too
PASS each client received it exactly once (no duplicates)
STAGE 5.6 CLUSTER CHECKS PASSED
```

---

## 7. Operations cheat sheet

| Task | Command |
|---|---|
| Build everything | `npm run build` |
| Run production server (Socket.IO capable) | `npm start` |
| Run plain Next (escape hatch) | `npm run nextstart` |
| Dev with sockets | `npm run dev:socket` |
| Tests | `npm test` (set `DATABASE_URL`; set `REDIS_URL` to include Redis tests) |
| Smoke | `JWT_SECRET=... bash scripts/smoke.sh` (`--record` to re-baseline) |
| Cluster check | start instances on 3000 and 3001 with the same `REDIS_URL`, then `node scripts/test-realtime-cluster.mjs` |

Windows `cmd`: set variables with `set X=Y` on their own line, no quotes. Git Bash accepts `X=Y command`.

Boot-log signals to watch: `realtime_adapter` (`redis` or `memory`), `redis_ready`, `redis_not_ready_at_boot`,
`redis_reconnecting`, `redis_command_failed`, `server_stats`, `shutdown_complete`.

Env: `REALTIME_PROVIDER` (boot), `REDIS_URL` (boot; must be `rediss://` for TLS providers such as Upstash),
`WEBHOOK_DISPATCH`, `WEBHOOK_RETRY`, `RATE_LIMIT_MODE` (request time), `CRON_SECRET`, `WEBHOOK_RETRY_BATCH`,
`SOAK_STATS_INTERVAL_MS`, `SHUTDOWN_TIMEOUT_MS`, `HOST`, `PORT`.

---

## 8. Known limitations and open items

- Events published while Redis is down are **not buffered**; other instances never see them.
- Behind a load balancer, keep sticky sessions or force websocket-only clients (long-polling needs affinity).
- Only `message.created` is routed to a realtime channel so far.
- `server.ts` does not share a DB pool with route bundles (rest of Track H1; the `process.exit` part is fixed).
- The 5.4 multi-day staging soak and its written note are still to be done by the operator.
- Browser check of dev HMR on `npm run dev:socket` is outstanding.
- Smoke baselines must be re-recorded (`--record`) on each environment after shape changes.
- Stage 6 is done for everything that has shipped (see 5.18). The client SDK has not been started, so the SDK parts of Stage 6 (`client.uploads` example, `packages/` in the docs, removal of `lib/client/`) wait for it.
- Credentials were pasted into chat during debugging (an Upstash password and a JWT secret). Both should be rotated;
  keep `.env.local` out of git.

## 9. Lessons

1. Verify with the real build (`next build`), not only `tsc` and unit tests.
2. State shared between `server.ts` and route bundles must live on `globalThis`.
3. Every fire-and-forget call in a process that treats `unhandledRejection` as fatal needs a guard.
4. Bound every shutdown step; a hung `quit()` or `close()` must never block exit.
5. Degrade, do not die: Redis trouble costs cross-instance delivery only, never REST or local delivery.
6. Timers in tests start after the action returns, not before.
7. Record response structure in baselines, never data.
8. TLS-only providers need `rediss://`; the symptom of getting it wrong is silent reconnect loops, so the boot log says so.
