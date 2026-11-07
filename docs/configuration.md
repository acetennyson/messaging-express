# Configuration

Everything is configured with environment variables. For local work put them in `.env.local` (copy `.env.example`); in production set them in your platform or in the compose file.

**Where `.env.local` is read.** Next.js loads it for the app itself. Standalone scripts (`npm run db:migrate`, `scripts/generate-token.js`) do **not**: pass it explicitly, for example `npx tsx --env-file=.env.local scripts/migrate.ts`. `PORT`, `HOST`, `SHUTDOWN_TIMEOUT_MS` and `SOAK_STATS_INTERVAL_MS` are read by `server.ts` before Next loads any env file, so they must be real environment variables, not lines in `.env.local`.

**Switches are live.** Feature switches (`RATE_LIMIT_MODE`, `WEBHOOK_DISPATCH`, `WEBHOOK_RETRY`, `E2EE_ENABLED`, `PARTICIPANT_ACCESS_MODE`) are read on every request. An unknown value falls back to the safe default and logs a warning once; it never crashes the server.

## Required

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string, e.g. `postgres://user:pass@localhost:5432/mx` |
| `JWT_SECRET` | Secret that signs and verifies every token. The server refuses to start without it. Use 32+ random bytes: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Anyone with this value can mint tokens for any project. |

## Server

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port for `server.ts` |
| `HOST` | `0.0.0.0` (production), `localhost` (dev) | Bind address |
| `NODE_ENV` | production unless started with `--dev` | `server.ts` sets it itself |
| `SHUTDOWN_TIMEOUT_MS` | `10000` (min 1000) | How long a graceful shutdown waits for in-flight work |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `SOAK_STATS_INTERVAL_MS` | `0` (off) | Log a `server_stats` line (memory, sockets, ...) every N ms. See [Load testing](load-testing.md) |
| `MAX_JSON_BODY_BYTES` | `262144` | Largest accepted JSON body |
| `PROJECT_CACHE_TTL_SECONDS` | `0` (off) | Cache the project/organization lookup for 1 to 3600 seconds to save one query per request. A project deactivated in the database may keep working for up to this long. |
| `JWT_EXPIRATION` | `7d` | Lifetime of tokens minted by the server's own helper (see [Authentication](authentication.md)) |

## CORS

| Variable | Default | Meaning |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated exact origins, no spaces, e.g. `https://app.example.com,https://admin.example.com`. Applies to REST and Socket.IO. |

## Feature switches

| Variable | Values (default first) | Guide |
|---|---|---|
| `PARTICIPANT_ACCESS_MODE` | `off`, `dry-run`, `enforce` | [Access control](access-control.md) |
| `RATE_LIMIT_MODE` | `off`, `dry-run`, `enforce` | [Rate limiting](rate-limiting.md) |
| `WEBHOOK_DISPATCH` | `off`, `on` | [Webhooks](webhooks.md) |
| `WEBHOOK_RETRY` | `off`, `on` | [Webhooks](webhooks.md#retries) |
| `E2EE_ENABLED` | `off`, `on` | [E2EE guide](e2ee/guide.md) |
| `REALTIME_PROVIDER` | `none`, `socketio` | [Realtime](realtime.md) |

## Realtime

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` | unset | Lets several instances share events. Needed whenever you run more than one. |

## Rate limits

| Variable | Default | Meaning |
|---|---|---|
| `RATE_LIMITS_JSON` | unset | JSON overrides per route group, see [Rate limiting](rate-limiting.md#customizing-the-limits) |

## Webhooks

| Variable | Default | Meaning |
|---|---|---|
| `WEBHOOK_TIMEOUT_MS` | `5000` | Time your endpoint has to answer |
| `WEBHOOK_RETRY_BATCH` | `25` | Deliveries retried per worker call |
| `WEBHOOK_SECRET` | unset | Fallback signing key for organizations that have no `webhook_secret` of their own |
| `CRON_SECRET` | unset | Bearer secret for `POST /api/internal/webhooks/retry`. The route refuses without it. |

The URL and signing secret are per organization, in the database, not in the environment.

## Storage

| Variable | Default | Meaning |
|---|---|---|
| `STORAGE_PROVIDER` | `local` | `local`, `s3`, `supabase`, `firebase`, `php` |
| `APP_URL` | `http://localhost:3000` | Public base URL; `local` uploads are returned as `APP_URL/uploads/<file>` |
| `MAX_UPLOAD_SIZE_BYTES` | `26214400` | Per file |
| `MAX_CONCURRENT_UPLOADS` | `4` | Files handled in parallel per request |
| `UPLOAD_ALLOWED_MIME_TYPES` | JPEG, PNG, GIF, WebP, MP4, WebM, PDF | Comma-separated |
| `S3_BUCKET` (or `AWS_S3_BUCKET`), `S3_REGION` (or `AWS_REGION`) | | S3 provider; credentials come from the standard AWS environment |
| `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_BASE_URL` | | For MinIO, R2 and other S3-compatible stores |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | | Supabase provider |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_STORAGE_BUCKET` | | Firebase provider (`\n` in the key is converted) |
| `PHP_UPLOAD_ENDPOINT` | | PHP provider, absolute URL |

See [Uploads](uploads.md).

## Encryption (E2EE)

Only relevant with `E2EE_ENABLED=on`.

| Variable | Default | Range | Meaning |
|---|---|---|---|
| `MAX_DEVICES_PER_USER` | `10` | 1 to 50 | Active devices per user, primary included |
| `E2EE_KEYS_MAX_BATCH` | `200` | 1 to 1000 | Wrapped-key entries in one request |
| `PAIRING_TTL_SECONDS` | `60` | 30 to 300 | How long a primary device's approval of a new device stays valid |

## Scripts only

Used by test and utility scripts, never by the server: `ALERT_WEBHOOK_URL`, `HEALTH_PATH`, `BASE_URL`, `PROJECT_ID`, `ORG_ID`/`ORGANIZATION_ID`, `SENDER_ID`, `OTHER_USER_ID`, `CONVERSATION_ID`, `WEBHOOK_SECRET`, `SOCKETS`, `PROBES`, `RATE`, `DURATION_S`, `OUT`, and similar. Each script documents its own in its header.
