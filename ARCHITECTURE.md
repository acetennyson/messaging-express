# Messaging Express: Architecture

What the system does **today**. Planned work is listed separately at the end and clearly marked. For how and why it got
here, see [`docs/ENGINEERING_LOG.md`](docs/ENGINEERING_LOG.md); for the staged plan, `IMPLEMENTATION_PLAN.md`.

## 1. What it is

A multi-tenant **Messaging-as-a-Service** backend. Customer applications call a REST API (JWT-authenticated) to manage
users, conversations and messages, upload attachments, and receive **events** two ways: signed **webhooks** to their
server, and **realtime** pushes over Socket.IO to their end users' clients.

One Next.js 16 application, one Postgres database (all tables prefixed `mx_`), run either as plain `next start` or,
by default, through a custom Node entrypoint (`server.ts`) that adds WebSockets.

```
                    ┌────────────────────────────────────────────────────┐
                    │                  node dist/server.js               │
 REST (JWT)         │  ┌──────────────────┐     ┌─────────────────────┐  │
 ─────────────────► │  │ Next.js handler  │     │ Socket.IO (optional)│  │ ◄── WebSocket (JWT)
                    │  │  app/api/v1/*    │     │ rooms conversation:*│  │
                    │  └────────┬─────────┘     └──────────▲──────────┘  │
                    │           │ emitEvent()              │ publish     │
                    │           ├──────────────────────────┘             │
                    │           └──► webhook sender ──► customer server  │
                    └───────────┬───────────────────────────┬────────────┘
                                │ pg                        │ pub/sub (only when REDIS_URL is set)
                         ┌──────▼──────┐             ┌──────▼──────┐
                         │  Postgres   │             │    Redis    │
                         │   (mx_*)    │             │ (optional)  │
                         └─────────────┘             └─────────────┘
```

## 2. Tenancy model

```
Organization ─1:N─► Project ─1:N─► User ─N:M─► Conversation ─1:N─► Message ─1:N─► Attachment / Reaction
```

- **Organization**: the paying account. Holds the webhook URL and secret.
- **Project**: one customer application. Every request is scoped to a project; every query filters on it.
- **User**: an end user inside a project, identified by `external_id` (the customer's own id).
- Tables: `mx_organizations`, `mx_projects`, `mx_users`, `mx_conversations`, `mx_conversation_participants`,
  `mx_messages`, `mx_message_attachments`, `mx_message_reactions`, `mx_typing_indicators`, `mx_webhook_logs`,
  `mx_rate_limits`, `mx_api_keys`, `mx_analytics_events`. Schema: `DATABASE_SCHEMA.md`, created by `npm run db:migrate`.

## 3. Request lifecycle (REST)

```
request ─► withCors ─► requireAuth ─► handler ─► response
                         │  1. verify JWT (JWT_SECRET)
                         │  2. load active project + organization  (optional cache, see 5.5)
                         │  3. rate limit (RATE_LIMIT_MODE)
                         └─ errors mapped by lib/errors.ts
```

Endpoints (all under `/api/v1`, JWT required unless noted): `users`, `conversations`, `messages`, `uploads`,
`uploads/presign`. Others: `GET /api/health` (no auth), `/uploads/<path>` (serves local uploads),
`/api/internal/webhooks/retry` (cron, `CRON_SECRET`).

### Error contract
Every error is `{ "error": { "message", "code", "details"? } }`.

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Schema violation, malformed JSON, rule violation (e.g. sender not a participant) |
| 401 | `UNAUTHORIZED` | Missing or invalid token, inactive project or organization. **Only** authentication failures |
| 404 | `NOT_FOUND` | The referenced resource does not exist in your project |
| 429 | `RATE_LIMIT_EXCEEDED` | Over the limit (`RATE_LIMIT_MODE=enforce`), with `Retry-After` |
| 500 | `INTERNAL_ERROR` | Anything unexpected. Message is always `Internal server error`; the cause is logged, never returned |

Implemented by typed errors and one mapper in `lib/errors.ts`. Not every route uses it yet: the older routes still
answer all failures with 400 (listed in the changelog).

## 4. Components

### 4.1 Authentication (`lib/auth`)
- JWT payload: `projectId`, `userId?`, `organizationId?`, `type` (`api` | `user` | `admin`), `exp`.
- **There is no token-exchange endpoint.** Tokens are minted by the customer's backend (or by
  `scripts/generate-token.js` in development) with the shared `JWT_SECRET` (`lib/auth/jwt.ts`).
- `loadActiveProject` (`lib/auth/project.ts`) is the single "project and organization are active" check. REST and the
  Socket.IO handshake both use it, so they cannot drift apart.

### 4.2 Database (`lib/db/pool.ts`)
`pg` pool (max 20, idle 30 s, connect timeout 5 s). An error on an idle connection is logged and the pool carries on
(it used to exit the process, which under WebSockets would disconnect everyone). `transaction()` helper for multi-step writes.

### 4.3 Validation and responses
Zod schemas in `lib/validation/schemas.ts`; response helpers in `lib/http.ts`. Success: `{ data, meta? }`.

### 4.4 Logging (`lib/logger`)
One JSON object per line on stdout (`timestamp`, `level`, `message`, `meta`); fields named `password`, `token`,
`apiKey`, `secret` are redacted. `LOG_LEVEL` = debug | info | warn | error | silent.

### 4.5 Feature flags (`lib/config/flags.ts`)
Read from `process.env` **on every request**, so a rollback is an env change, not a deploy. Unknown values fall back to
the safe default and log once. Boot-time exceptions: `REALTIME_PROVIDER`, `REDIS_URL`.

## 5. Subsystems

### 5.1 Rate limiting (`lib/rate-limit`)
- Fixed-window counters in Postgres (`mx_rate_limits`), per **project + user**, keyed `rl:<group>:<projectId>:<user|api>`.
- Modes (`RATE_LIMIT_MODE`): `off` (default, no query), `dry-run` (logs `rate_limit_would_block`), `enforce` (429 + `Retry-After`).
  Responses carry `X-RateLimit-Limit/Remaining/Reset` when not `off`.
- Defaults per minute: `messages:POST` 120, `messages:GET` 600, `uploads:POST` 30, `uploads/presign:POST` 60,
  `conversations` 120, `users` 120, everything else 300. Override with `RATE_LIMITS_JSON`.
- **Fails open**: it never throws, so a limiter problem cannot take the API down. Expired rows are cleaned up
  opportunistically. The store sits behind a provider interface; a Redis provider is a possible later swap.

### 5.2 Events (`lib/events/emit.ts`)
Routes call `emitEvent({ projectId, event, data, channel? })` after the response data is ready. It never throws into the
request. Work runs after the response (`after()` from `next/server`, with a safe fallback) and is tracked so shutdown can wait for it.
Two sinks: the webhook sender (if `WEBHOOK_DISPATCH=on`) and the realtime provider (if one is registered and a `channel` is given).

Emitted today: `user.created`, `user.updated`, `conversation.created`, `message.created`.
Other names in the type exist but nothing emits them yet. Only `message.created` has a realtime channel.

### 5.3 Webhooks (`lib/webhooks`)
- Target: the organization's `webhook_url`; signed with HMAC-SHA256 (secret from the organization, else `WEBHOOK_SECRET`) in `X-Webhook-Signature`.
- Every delivery is logged in `mx_webhook_logs`. **At-least-once**: receivers must be idempotent.
- With `WEBHOOK_RETRY=on`, failures are retried after 1 min, 5 min, 30 min, 2 h (5 attempts in total). A cron calls
  `POST /api/internal/webhooks/retry` (`Authorization: Bearer $CRON_SECRET`); rows are claimed with `FOR UPDATE SKIP LOCKED`
  and a 120 s lease so overlapping runs never double-send. If the organization removed its URL meanwhile, the row is marked "gave up".

### 5.4 Realtime (`lib/realtime`, `server.ts`)
Path A: Socket.IO runs **inside the same Node process** as Next, attached by `server.ts` (`REALTIME_PROVIDER=socketio`).
Other paths (a separate realtime service, or a hosted provider) are planned alternatives behind the same
`RealtimeProvider { publish, close?, stats? }` interface.

- **Handshake**: `io(url, { auth: { token } })`, same JWT as REST; connect errors carry `err.data.code`
  (`AUTH_REQUIRED` | `INVALID_TOKEN` | `PROJECT_INACTIVE`). A socket is disconnected when its token expires; the client reconnects with a fresh one.
- **Rooms**: `conversation:<id>`. Clients emit `join-conversation` / `leave-conversation` with an ack
  `{ ok: true } | { ok: false, code }` (`INVALID_PAYLOAD` | `FORBIDDEN` | `RATE_LIMITED` | `INTERNAL_ERROR`). Joining requires being a participant in a conversation of the token's project. Joins are limited to 20 per 10 s.
- **Events** are emitted to the room under their own name (`message.created`).
- **Several instances**: set `REDIS_URL` on every instance (Socket.IO Redis adapter). Without it, events reach only sockets on the instance that produced them. Redis trouble degrades to that, never to an outage. Use `rediss://` for TLS providers such as Upstash. Behind a load balancer keep sticky sessions or force websocket-only.
- **Shared state** between `server.ts` and route bundles lives on `globalThis` under `Symbol.for(...)`, because Next bundles routes separately.
- **Shutdown** (SIGTERM): stop accepting, drain in-flight events, close realtime, then exit; bounded by `SHUTDOWN_TIMEOUT_MS`. Uncaught errors are fatal (exit 1).

### 5.5 Project lookup cache (optional)
`PROJECT_CACHE_TTL_SECONDS` (1 to 3600, default off) reuses a successful project lookup in memory. A deactivated project keeps
working on each instance for up to that long. Failures are never cached. See `CHANGELOG.md`.

### 5.6 Uploads and storage (`lib/storage`)
- `STORAGE_PROVIDER` = `local` (default) | `s3` | `supabase` | `firebase` | `php`. A provider is validated only when selected.
- `POST /api/v1/uploads`: server-side upload (multipart), returns `data: [{ url, ... }]`. Local files are served at `/uploads/<path>`.
- `POST /api/v1/uploads/presign`: presigned direct upload for providers that support it (`501` otherwise).
- Attachments are attached to a message by URL in `POST /api/v1/messages`.
- `lib/client/uploadClient.ts` is a browser helper (parallel uploads); it is superseded by the SDK once that exists.

### 5.7 CORS (`lib/cors`)
Global, from `CORS_ALLOWED_ORIGINS` (`*` or a comma-separated list; a list also enables credentials). Not per project.

### 5.8 Health
`GET /api/health`: runs `SELECT 1`; `200 ok`, or `503` when the database is unreachable or slower than 2 s. Used by load balancers for rolling deploys.

## 6. Running it

| Command | What it runs |
|---|---|
| `npm run build` | `next build` then compiles `server.ts` to `dist/` |
| `npm start` | `node dist/server.js`: Next + optional Socket.IO, graceful shutdown |
| `npm run nextstart` | plain `next start` (no WebSockets); the rollback path |
| `npm run dev` / `dev:socket` | Next dev / dev with Socket.IO |
| `npm test` | vitest (some suites need `DATABASE_URL`, the Redis suite needs `REDIS_URL`) |

Rolling deploy: start new instances, wait for `/api/health`, move traffic, stop old ones with SIGTERM.
Runbooks: `docs/CUTOVER_RUNBOOK.md`, `docs/SOAK_RUNBOOK.md`. Environment variables: `README.md` and `.env.example`.

## 7. Testing and verification

- Unit and integration tests under `lib/**` and `app/**` (vitest, real Postgres where it matters).
- `scripts/smoke.sh`: response-shape baselines for the REST contract. `scripts/test-webhooks.sh`,
  `scripts/test-realtime.mjs`, `scripts/test-realtime-cluster.mjs` (two instances sharing Redis), `scripts/soak/*`.

## 8. Not built yet

- **Client SDK** (`packages/*`): scaffold, REST wrappers, realtime, publishing. Until then, call the REST API directly.
- **Realtime paths B and C** (separate realtime service with Redis, or Pusher/Ably/Supabase).
- Redis-backed rate limiting; cross-instance invalidation of the project cache.
- Events other than `message.created` over realtime; typing and presence over realtime.
- Search, voice, video, analytics UI, billing, multi-region, end-to-end encryption (`REDESIGN.md` section 9 is the next roadmap item).
- Error-contract cleanup for the remaining `app/api/v1/*` routes.

---
*Last updated: October 24, 2026.*
