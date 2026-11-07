# Deployment

How to run Messaging Express in production, roll out updates without downtime, and scale to more than one instance.

**Contents:** [What you need](#what-you-need) · [Docker](#docker) · [Without Docker](#without-docker) · [Health checks](#health-checks) · [Updating](#updating-a-running-system) · [Graceful shutdown](#graceful-shutdown) · [Scaling out](#scaling-out) · [Turning features on](#turning-features-on-safely) · [Checklist](#production-checklist)

## What you need

- Node.js 22 (see `.nvmrc`) and a **long-running process**. Realtime needs a persistent server, so serverless hosts (Vercel, Netlify) can only run the REST API (`npm run build:next` + their own runtime), without Socket.IO.
- Postgres 13 or newer.
- Optional: Redis (only if you run several instances with realtime), S3-compatible storage (only if you run several instances or want durable uploads).
- A reverse proxy or platform load balancer with TLS. Forward WebSocket upgrades.

## Docker

The repo ships a `Dockerfile` (multi-stage, Node 22, runs `node dist/server.js` as a non-root user) and a `docker-compose.yml` with Postgres, Redis, the app and a one-off migration job.

```bash
cp env.docker.example .env.docker
# edit .env.docker: set JWT_SECRET (node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
# and APP_URL / CORS_ALLOWED_ORIGINS to your real URL

docker compose --env-file .env.docker up -d db redis
docker compose --env-file .env.docker --profile tools run --rm migrate
docker compose --env-file .env.docker --profile app up --build -d
curl http://localhost:3000/api/health
```

What the compose app service sets for you: `STORAGE_PROVIDER=local` (files in the `uploads` volume mounted at `/app/.uploads`), `REALTIME_PROVIDER=socketio` with Redis, `RATE_LIMIT_MODE=off`, `WEBHOOK_DISPATCH=off`. Override any of them in `.env.docker`. The container has a health check against `/api/health`, and a 15-second stop grace period (longer than the 10-second graceful shutdown).

Developing against Docker services while running the app on your machine:

```bash
docker compose --env-file .env.docker up -d db redis
npx tsx --env-file=.env.local scripts/migrate.ts
npm run dev:socket
```

## Without Docker

```bash
npm ci
npm run build                   # next build + compiles server.ts to dist/
npx tsx scripts/migrate.ts      # with DATABASE_URL in the environment
NODE_ENV=production PORT=3000 npm start      # runs node dist/server.js
```

`npm start` does not build; if `dist/server.js` is missing you ran `build:next` or skipped the build. `npm run nextstart` runs plain `next start` (REST only, no realtime).

Run it under a process manager that restarts it on exit (systemd, pm2, Docker's `restart: unless-stopped`). The process exits non-zero on a crash by design.

Example systemd unit:

```ini
[Service]
WorkingDirectory=/srv/messaging-express
EnvironmentFile=/etc/messaging-express.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
TimeoutStopSec=15
User=chat
```

## Health checks

`GET /api/health` needs no token and returns `200` with `{"status":"ok","database":"healthy",...}`. It returns `503` when the database is unreachable or takes longer than 2 seconds to answer a trivial query. Point your load balancer and uptime monitor at it.

## Updating a running system

1. Take a database backup.
2. Build the new version. Run `scripts/migrate.ts` (safe to re-run; only adds things).
3. Start a **new** instance next to the old one, wait for `/api/health` to answer 200, then run `bash scripts/smoke.sh` against it as a last check.
4. Shift traffic to it, then stop the old instance with SIGTERM.
5. Watch the logs for an hour: `server_listening`, and no `uncaught_exception` or `unhandled_rejection`.

**Rollback:** redeploy the previous image or commit. Migrations are additive, so the old version still works on the migrated database.

## Graceful shutdown

On SIGTERM or SIGINT the server stops accepting new connections, tells Socket.IO clients to disconnect (they reconnect to another instance), waits for in-flight webhook and realtime work for up to `SHUTDOWN_TIMEOUT_MS` (default 10 s), then exits 0. Give your platform a stop grace period longer than that. If the timeout hits, it logs `shutdown_forced` and exits anyway.

## Scaling out

More than one instance works with three conditions:

1. **Redis for realtime.** Set the same `REDIS_URL` on every instance. At boot the log shows `realtime_adapter` with `redis` or `memory`. Two instances showing `memory` silently lose events between them.
2. **Shared uploads.** The `local` provider writes to one machine's disk. Use `STORAGE_PROVIDER=s3` (or another remote provider) with several instances.
3. **Sticky sessions or WebSocket-only clients.** Socket.IO's long-polling fallback needs requests from one client to reach the same instance. Either enable stickiness on the load balancer, or connect with `transports: ['websocket']`.

REST routes are stateless and rate-limit counters live in Postgres, so nothing else needs coordination. Each instance has its own database pool; check the total connection count against your database limit.

## Turning features on safely

Each feature is an independent switch with a way back. Change one at a time and watch the logs:

| Step | Setting | Back out by |
|---|---|---|
| Realtime | `REALTIME_PROVIDER=socketio` (new instance, then traffic) | unset it and restart; REST is unaffected, sockets just fail to connect |
| Rate limits | `dry-run`, then `enforce` ([guide](rate-limiting.md#rolling-it-out)) | set `off` |
| Participant access | `dry-run`, then `enforce` ([guide](access-control.md#rolling-it-out-safely)) | set `dry-run` or `off` |
| Webhooks | `WEBHOOK_DISPATCH=on`, then `WEBHOOK_RETRY=on` plus the retry cron | set `off` |
| Encryption | `E2EE_ENABLED=on` ([guide](e2ee/guide.md#turning-it-on)) | set `off` hides the routes but stops protecting existing encrypted conversations, so read [this](e2ee/guide.md#turning-it-off-read-this-first) first |

## Production checklist

- [ ] `JWT_SECRET` is long, random and stored as a secret; it is the same on every instance.
- [ ] `CORS_ALLOWED_ORIGINS` lists your real origins instead of `*`.
- [ ] TLS terminates in front, and WebSocket upgrades are forwarded.
- [ ] Postgres has backups and the connection limit fits all instances.
- [ ] `/api/health` is monitored.
- [ ] Process manager restarts the server; stop grace period is longer than `SHUTDOWN_TIMEOUT_MS`.
- [ ] More than one instance? `REDIS_URL`, S3 storage and sticky sessions are set.
- [ ] Rate limiting is at least on `dry-run`, and your backend uses API tokens, never user tokens, for admin work.
- [ ] Old `mx_webhook_logs` rows are archived or deleted on a schedule.
- [ ] Your app never exposes `JWT_SECRET` or an API/admin token to browsers.
