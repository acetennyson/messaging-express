# Realtime cutover runbook (Stage 5.5)

**What changes:** `npm start` now runs the compiled `server.ts` (`node dist/server.js`) instead of `next start`. The old command is still there as `npm run nextstart`.

**What does not change:** with `REALTIME_PROVIDER` unset (`none`) `npm start` serves exactly what `next start` served (same routes, same responses, verified with `scripts/smoke.sh`). Realtime turns on only when you set `REALTIME_PROVIDER=socketio`. So there are two independent switches, and you flip them in two separate deploys:

1. **Switch the start command** (`next start` -> `npm start`), realtime still off.
2. **Turn realtime on** (`REALTIME_PROVIDER=socketio`).

## Before you start

- [ ] The 5.4 soak note is written and says REST is equivalent and nothing grows (see `docs/SOAK_RUNBOOK.md`).
- [ ] The host keeps a long-running Node process (not Vercel/Netlify).
- [ ] The build command is `npm run build` (this builds Next **and** `dist/server.js`). Hosts that run `npm run build` by default need no change.
- [ ] Exactly **one** instance. Until the Redis adapter (5.6) is live, two realtime instances silently lose events between them.
- [ ] The load balancer / proxy forwards websocket upgrades and has sticky sessions, or your clients use `transports: ['websocket']`.
- [ ] A process manager restarts the process on exit (it exits 1 on a crash by design).
- [ ] The previous release (image or commit) is noted, for rollback.

## Step 1: new start command, realtime off

1. Build the new release: `npm run build`.
2. Start it **next to** the old one (a second instance or a new container) with the same environment and **no** `REALTIME_PROVIDER`:
   `npm start`
3. Wait for `GET /api/health` to return 200 on the new instance, run `bash scripts/smoke.sh` against it (exits 0).
4. Shift traffic to the new instance (blue/green or rolling), then stop the old one. It gets SIGTERM; `next start` finishes in-flight requests and exits.
5. Watch the logs for an hour: `server_listening`, no `uncaught_exception`, error rate and latency unchanged.

**Rollback:** run `npm run nextstart` (or redeploy the previous image). Nothing else changed, nothing to undo.

## Step 2: realtime on

1. Set `REALTIME_PROVIDER=socketio` in the environment (it is read at boot).
2. Roll it like step 1: new instance up and healthy first, then traffic, then stop the old one. Connected sockets on the old instance get `io server disconnect`, reconnect, and land on the new one.
3. Verify against the live URL: `JWT_SECRET=... BASE_URL=https://<host> node scripts/test-realtime.mjs` (use a staging project; it writes one user and one message).
4. Watch for an hour: `realtime_publish_failed`, `realtime_join_failed`, `shutdown_forced`, socket count, memory (`SOAK_STATS_INTERVAL_MS=60000` makes the server log `server_stats`).

**Rollback:** unset `REALTIME_PROVIDER` (or set `none`) and restart. Realtime events stop, REST keeps working, no data is affected. Clients' sockets just fail to connect.

## Rolling restarts afterwards

New instance healthy on `/api/health` -> shift traffic -> SIGTERM the old one. `server.ts` stops accepting connections, disconnects sockets (clients reconnect automatically), lets in-flight webhook work finish (up to `SHUTDOWN_TIMEOUT_MS`, default 10 s) and exits 0. Give your platform a stop grace period of at least that long plus a few seconds.

## Notes

- `npm start` does not build. If `dist/server.js` is missing you built with `npm run build:next` or skipped the build: run `npm run build`.
- `NODE_ENV` does not need to be set: `server.ts` runs in production mode unless started with `--dev` or `NODE_ENV=development`.
- `PORT` and `HOST` configure the bind address (not `HOSTNAME`).
- Serverless hosts ignore all of this: they run `next build` and their own server. Use `npm run build:next` there if the full build is a problem.
