# Troubleshooting

Find your symptom, check the likely cause. Server logs are JSON lines on stdout; search for the quoted names below.

## Starting up

| Symptom | Cause and fix |
|---|---|
| `JWT_SECRET environment variable is not set` | Set `JWT_SECRET`. Scripts do not read `.env.local`: pass it with `--env-file=.env.local` or export it. |
| `npm run db:migrate` says `DATABASE_URL` is missing | Same reason: `npx tsx --env-file=.env.local scripts/migrate.ts` |
| Port or host from `.env.local` is ignored | `PORT`, `HOST`, `SHUTDOWN_TIMEOUT_MS` and `SOAK_STATS_INTERVAL_MS` are read before env files load. Set them in the real environment. |
| `npm start` fails: cannot find `dist/server.js` | Run `npm run build` first (not `build:next`). |
| Everything returns `500` and `/api/health` returns `503` | The database is unreachable. Check `DATABASE_URL`, network, and the connection limit. The REST body for this is the generic `Internal server error`; the real cause is in the server log. |
| `relation "mx_..." does not exist` | Migrations have not run on this database. |

## Authentication

| Symptom | Cause and fix |
|---|---|
| `401` on every call | Wrong or missing `Authorization: Bearer <token>`; the token was signed with a different `JWT_SECRET`; or it expired (`exp`). Decode the token (jwt.io, offline) and check `projectId`, `type` and `exp`. |
| `401` for a token that was working | The project or organization was deactivated (`is_active = false`), or the project row was deleted. With `PROJECT_CACHE_TTL_SECONDS` set it can take that long to take effect. |
| `403` "You are not a participant" | The token is a user token and `PARTICIPANT_ACCESS_MODE=enforce`, or the conversation is encrypted. Use the right user's token, or an API token from your backend. See [Access control](access-control.md). |
| `403` "A user token can only send as that user" | `senderId` is not the token's `userId`. |
| Browser: CORS error | `CORS_ALLOWED_ORIGINS` is set and does not exactly match the page's origin (scheme, host and port; no spaces after commas; no trailing slash). |

## Data looks wrong

| Symptom | Cause and fix |
|---|---|
| A user's email or metadata vanished after `POST /users` | Same `externalId` **replaces** the user. Always send the whole record. |
| Duplicate users | You called `POST /users` without `externalId`; each call creates a new user. |
| `400` "One or more participantIds are not users of this project" | The ids must be Messaging Express user ids (UUIDs from `POST /users`), not your own ids, and must belong to the token's project. |
| Messages come back in reverse order | `GET /messages` is newest first by design. Reverse them for display. |
| Counts like `"message_count": "5"` are strings | Postgres counts; convert with `Number()`. |
| Unread counts never go down | There is no read-marking endpoint yet. |

## Realtime

| Symptom | Cause and fix |
|---|---|
| No `/socket.io` endpoint | `REALTIME_PROVIDER` is not `socketio`, or you started with `npm run dev` or `npm run nextstart`. Use `npm run dev:socket` or `npm start`. |
| `connect_error` with `INVALID_TOKEN` | Expired token or wrong secret. |
| `join-conversation` ack `FORBIDDEN` | The user is not a participant, or the token has no `userId` (API tokens cannot join). |
| Works with one instance, events lost with two | Set the same `REDIS_URL` on both. The boot log shows `realtime_adapter` as `redis` or `memory`. |
| Sockets drop every few minutes | A proxy or load balancer idle timeout is shorter than Socket.IO's ping interval. Raise the timeout. |
| Events missed while offline | They are not replayed. Fetch `GET /messages` after reconnecting. |

## Webhooks

| Symptom | Cause and fix |
|---|---|
| Nothing arrives | `WEBHOOK_DISPATCH` is not exactly `on`, or the organization has no `webhook_url`. Look at `mx_webhook_logs`. |
| Signature does not match | Verify against the **raw** body, with the organization's `webhook_secret` (or `WEBHOOK_SECRET` if that is null). Re-serializing the JSON changes the bytes. |
| Failed deliveries never retry | `WEBHOOK_RETRY=on` and a scheduler calling `/api/internal/webhooks/retry` with `CRON_SECRET` are both needed. |
| Duplicate deliveries | Expected: delivery is at least once. Make the handler idempotent. |

## Uploads

| Symptom | Cause and fix |
|---|---|
| `File type not allowed` in a result | Not in `UPLOAD_ALLOWED_MIME_TYPES`. Note that `POST /uploads` answers `200` even when files failed. |
| `501 PRESIGN_NOT_SUPPORTED` | `local` and `php` providers cannot presign. Use `POST /uploads`. |
| Uploaded files vanish after a deploy | The `local` provider writes to `.uploads` in the working directory. Mount a volume there, or use S3. |
| `STORAGE_MISCONFIGURED` | The selected provider's required variables are missing. |

## Limits

| Symptom | Cause and fix |
|---|---|
| `413 PAYLOAD_TOO_LARGE` | JSON body above `MAX_JSON_BODY_BYTES` (256 KiB default). |
| `429 RATE_LIMIT_EXCEEDED` | Wait `Retry-After` seconds, or raise limits with `RATE_LIMITS_JSON`. |

## Encryption

| Symptom | Cause and fix |
|---|---|
| Every encryption route returns `404` | `E2EE_ENABLED` is not `on`. |
| `409 STALE_DEVICE_SET` | A device was added or removed since you built the key list. Use `details.deviceIds` and retry (the client package does this). |
| `409 KEY_ROTATION_REQUIRED` | A member was removed. Fetch the newest keys and re-encrypt; the client package does this once automatically. |
| `409 PARTICIPANT_HAS_NO_DEVICE` | That user has not registered a device yet. |
| `409 DEVICE_LIMIT` | The user is at `MAX_DEVICES_PER_USER`. Revoke an old device. |

Still stuck? Open an issue with the request, the response, and the relevant log lines (remove secrets).
