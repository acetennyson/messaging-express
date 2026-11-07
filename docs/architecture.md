# Architecture

How Messaging Express is built, for people who want to understand it, debug it, or contribute. For using it, start with the [README](../README.md).

## What it is

A multi-tenant messaging backend. Your applications call a REST API (authenticated with JWTs) to manage users, conversations and messages and to upload attachments. The server tells you what happened in two ways: signed **webhooks** to your server, and **realtime** pushes over Socket.IO to your users' clients. Optionally, conversations can be end-to-end encrypted.

It is one Next.js 16 application and one Postgres database (tables prefixed `mx_`), started through a small custom Node entrypoint (`server.ts`) that adds WebSockets.

```
                    ┌────────────────────────────────────────────────────┐
                    │                  node dist/server.js               │
 REST (JWT)         │  ┌──────────────────┐     ┌─────────────────────┐  │
 ─────────────────► │  │ Next.js handler  │     │ Socket.IO (optional)│  │ ◄── WebSocket (JWT)
                    │  │  app/api/v1/*    │     │ rooms conversation:*│  │
                    │  └────────┬─────────┘     └──────────▲──────────┘  │
                    │           │ emitEvent()              │ publish     │
                    │           ├──────────────────────────┘             │
                    │           └──► webhook sender ──► your server      │
                    └───────────┬───────────────────────────┬────────────┘
                                │ pg                        │ pub/sub (only with REDIS_URL)
                         ┌──────▼──────┐             ┌──────▼──────┐
                         │  Postgres   │             │    Redis    │
                         │   (mx_*)    │             │ (optional)  │
                         └─────────────┘             └─────────────┘
```

## Tenancy

```
Organization ─1:N─► Project ─1:N─► User ─N:M─► Conversation ─1:N─► Message ─1:N─► Attachment
```

An **organization** is the account (it owns the webhook URL and secret). A **project** is one application of that customer; every token names a project and every query filters by it. A **user** is an end user inside a project, identified by your own `externalId`. See [Concepts](concepts.md) and [Database](database.md).

## How a request flows

```
request ─► CORS ─► requireAuth ─► route handler ─► response
                     1. verify the JWT with JWT_SECRET
                     2. load the project + organization, reject if inactive (optionally cached)
                     3. rate limit (RATE_LIMIT_MODE)
                     errors are mapped to {error:{message,code}} in one place (lib/errors.ts)
```

The route list and error table are in the [API reference](api-reference.md).

## Main pieces (and where they live)

| Piece | Code | Notes |
|---|---|---|
| Auth | `lib/auth` | JWT verification; `loadActiveProject` is the single "project and organization are active" check, used by both REST and the Socket.IO handshake so they cannot drift apart. There is no token-exchange endpoint: your backend mints tokens. |
| Database | `lib/db/pool.ts` | `pg` pool (max 20 connections, idle 30 s, connect timeout 5 s). An error on an idle connection is logged and the pool carries on. `transaction()` wraps multi-step writes. |
| Validation and responses | `lib/validation`, `lib/http.ts` | Zod schemas; `{ data, meta? }` on success. |
| Errors | `lib/errors.ts` | Typed errors and one mapper. Postgres foreign-key violations become `400`, unique violations `409`, without leaking constraint names. |
| Logging | `lib/logger` | One JSON object per line on stdout. Fields named `password`, `token`, `apiKey`, `secret` are redacted. |
| Switches | `lib/config/flags.ts` | Read from `process.env` on every call, so a rollback is an env change, not a deploy. Unknown values fall back to the safe default and warn once. |
| Rate limiting | `lib/rate-limit` | Fixed windows in Postgres; fails open. See [Rate limiting](rate-limiting.md). |
| Events | `lib/events/emit.ts` | The one place a route publishes a side effect. |
| Webhooks | `lib/webhooks` | Signed, logged, optionally retried. See [Webhooks](webhooks.md). |
| Realtime | `lib/realtime`, `server.ts` | Socket.IO inside the same process. See [Realtime](realtime.md). |
| Storage | `lib/storage` | Provider interface with five implementations. See [Uploads](uploads.md). |
| Encryption | `lib/e2ee` | Server side of end-to-end encryption. See [E2EE overview](e2ee/overview.md). |
| Access checks | `lib/auth/access.ts` | Participant rules for user tokens. See [Access control](access-control.md). |

### Events

Routes call `emitEvent({ projectId, event, data, channel?, webhook? })` once their data is ready. It never throws into the request and never needs awaiting: the work runs **after the response** (`after()` from `next/server`, with a plain-promise fallback outside a request) and is tracked, so a graceful shutdown can wait for it. Two independent sinks: the webhook sender (when `WEBHOOK_DISPATCH=on` and `webhook` is not `false`) and the realtime provider (when one is registered and a `channel` is given).

### Realtime internals

- `server.ts` creates the HTTP server, hands requests to Next, and (when `REALTIME_PROVIDER=socketio`) attaches Socket.IO and registers a `RealtimeProvider { publish, evictUser?, stats?, close? }`.
- State shared between `server.ts` and the route bundles lives on `globalThis` under `Symbol.for(...)`, because Next bundles each route separately.
- With `REDIS_URL`, the Socket.IO Redis adapter relays broadcasts between instances. If Redis fails, delivery degrades to "only sockets on the same instance", never to an outage. Use `rediss://` for TLS providers.
- Shutdown (SIGTERM or SIGINT): stop accepting, drain in-flight events, close realtime, exit; bounded by `SHUTDOWN_TIMEOUT_MS`. Uncaught errors are fatal (exit 1) so the process manager restarts a clean process.

### Webhook delivery

Each delivery is a row in `mx_webhook_logs`. With `WEBHOOK_RETRY=on`, failed rows get a `next_retry_at`. The retry route claims due rows with `FOR UPDATE SKIP LOCKED` and a 120-second lease, so overlapping workers never send the same row twice. A retry resends the stored body byte for byte with a fresh valid signature.

### Project lookup cache

`PROJECT_CACHE_TTL_SECONDS` (1 to 3600; off by default) keeps a successful project lookup in memory per instance. A deactivated project keeps working on each instance for up to that long. Failures are never cached.

## Design rules worth knowing

- **Every new behaviour sits behind a switch that defaults to off**, and with the switch off a route behaves exactly as it did before. Flags are read per request so they can be rolled back instantly.
- **Migrations only add.** The migration file is re-run on every deploy; each step is idempotent and non-destructive.
- **Tenant isolation is a query filter**, not separate databases: every query includes the project id from the verified token.
- **The server never holds secrets for encryption.** It checks structure and permissions, not secrecy.

## Not built yet

- Endpoints to edit or delete messages, reactions, typing and presence, read receipts, fetching one conversation or its participants, archiving.
- Realtime events other than message events (and encryption events); a separate realtime service or a hosted provider (Pusher, Ably, Supabase) behind the same provider interface.
- Redis-backed rate limiting; cross-instance invalidation of the project cache.
- Per-project CORS and rate limits (the columns exist; nothing reads them).
- A signup/admin API for organizations and projects (use SQL).
- Search, voice and video, billing, analytics.
