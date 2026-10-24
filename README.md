# Messaging Express 🚀

A professional **Messaging-as-a-Service (MAAS)** platform built with Next.js, Postgres, and WebSockets. Integrate real-time messaging into your applications without building it from scratch.

**Support for:** Text, Images, Videos, Files, Reactions, Typing Indicators, Read Receipts, and more.

---

## 🎯 Features

### Core Messaging
- ✅ **Real-time delivery** over Socket.IO (opt-in, `REALTIME_PROVIDER=socketio`; see [Realtime](#-realtime-socketio))
- ✅ **Multi-media support** (text, images, videos, files)
- ✅ **Conversation types** (direct, group, customer support)
- ✅ **Message threading** (replies and threads)
- ✅ **Message reactions** (emoji reactions)
- ✅ **Typing indicators** and presence
- ✅ **Read receipts** and unread counts
- ✅ **Message editing and deletion**

### Multi-Tenancy
- ✅ **Organizations** - Top-level account management
- ✅ **Projects** - Multiple projects per organization
- ✅ **API Keys** - Project-specific authentication
- ✅ **Custom settings** per project
- ✅ **CORS configuration** per project

### Developer Experience
- ✅ **RESTful API** with consistent JSON responses
- ✅ **JWT authentication** for secure access
- ✅ **Rate limiting** per user per route (off / dry-run / enforce; see [Rate limiting](#rate-limiting))
- ✅ **Signed webhooks** with retries and exponential backoff (see [Webhooks](#-webhooks))
- ✅ **Analytics events** for tracking usage
- ✅ **Comprehensive error handling**
- ✅ **Request logging** with request IDs

### Production Ready
- ✅ **Postgres connection pooling**
- ✅ **Transaction support** for data integrity
- ✅ **Indexed queries** for performance
- ✅ **Health check endpoint** for monitoring
- ✅ **Structured logging** (JSON format)
- ✅ **Environment-based configuration**

---

## 🏗️ Architecture

```
messaging-express/
├── app/
│   ├── api/
│   │   ├── v1/
│   │   │   ├── conversations/    # Conversation management
│   │   │   ├── messages/         # Message CRUD
│   │   │   ├── users/            # User management
│   │   │   └── reactions/        # Message reactions
│   │   └── health/               # Health check
│   ├── layout.tsx
│   └── page.tsx                  # API playground (coming soon)
├── lib/
│   ├── auth/                     # JWT & middleware
│   ├── db/                       # Database pool & queries
│   ├── logger/                   # Structured logging
│   ├── services/                 # Media upload & webhooks
│   ├── utils/                    # API key generation
│   └── validation/               # Zod schemas
├── scripts/
│   └── migrate.ts                # Database migrations
└── DATABASE_SCHEMA.md            # Full schema documentation
```

---

## 🚀 Quick Start

### 1. Prerequisites

- **Node.js** 20+ 
- **PostgreSQL** 14+ (Supabase recommended)
- **npm** or **yarn**

### 2. Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd messaging-express

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local
```

### 3. Configuration

Edit `.env.local` (every variable is documented in `.env.example`):

```env
# Required
DATABASE_URL=postgresql://user:password@host:5432/database
JWT_SECRET=<run: openssl rand -base64 48>

# Optional
APP_URL=http://localhost:3000
LOG_LEVEL=info
```

#### Feature flags (all default to the safe, old behaviour)

Flags are read **at request time** (except `REALTIME_PROVIDER`, read at boot), so turning one off is an env change, not a redeploy.
Set them in the **server's own environment** before it starts: exporting one in the terminal that runs a test script does nothing.
Values must be exact: `on`, not `true` or `1` (an unrecognised value is ignored and logged as `invalid_flag_value`).

| Variable | Values (default first) | What it does |
|---|---|---|
| `STORAGE_PROVIDER` | `local` \| `s3` \| `supabase` \| `firebase` \| `php` | Where uploads go (`MAX_UPLOAD_SIZE_BYTES`, `MAX_CONCURRENT_UPLOADS`, `UPLOAD_ALLOWED_MIME_TYPES`) |
| `RATE_LIMIT_MODE` | `off` \| `dry-run` \| `enforce` | `dry-run` only logs `rate_limit_would_block`; `enforce` returns `429` + `Retry-After` |
| `RATE_LIMITS_JSON` | unset | Per-route overrides, e.g. `{"messages:POST":{"limit":60,"windowMs":60000}}` |
| `WEBHOOK_DISPATCH` | `off` \| `on` | Send webhooks to the organization's `webhook_url` |
| `WEBHOOK_RETRY` | `off` \| `on` | Retry failed deliveries (needs `CRON_SECRET` and a cron, see [Webhooks](#-webhooks)) |
| `CRON_SECRET` | unset | Bearer secret for `POST /api/internal/webhooks/retry` (the route refuses everything while unset) |
| `WEBHOOK_RETRY_BATCH` | `25` | Max retries per cron call (1 to 100) |
| `PROJECT_CACHE_TTL_SECONDS` | unset (off) | Reuse a successful project lookup for this many seconds (1 to 3600) instead of one Postgres query per request. Read per request. A project or organization you deactivate keeps working on each instance for up to this long; failures are never cached. Try `15` |
| `REALTIME_PROVIDER` | `none` \| `socketio` | Realtime transport. **Read at boot**; only used by `server.ts` |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Graceful-shutdown budget for `server.ts` |
| `SOAK_STATS_INTERVAL_MS` | `0` (off) | `server.ts` logs a `server_stats` line (memory, sockets, in-flight work, event-loop delay) this often |
| `HOST`, `PORT` | `localhost`/`0.0.0.0`, `3000` | Bind address for `server.ts` (not `HOSTNAME`: Docker/Windows set that to the machine name) |

### 4. Database Setup

```bash
# Run migrations
npm run db:migrate
```

### 5. Start Development Server

```bash
npm run dev            # plain `next dev`: REST API only, no realtime
npm run dev:socket     # server.ts in dev mode + Socket.IO (set REALTIME_PROVIDER=socketio first)
```

Visit [http://localhost:3000/api/health](http://localhost:3000/api/health) to verify the setup.

Load the test fixtures (idempotent, dev/staging databases only) used by the scripts below:

```bash
psql "$DATABASE_URL" -f scripts/smoke-seed.sql
```

---

## 📚 API Documentation

### Base URL
```
http://localhost:3000/api/v1
```

### Authentication

All API requests (except `/health`) require a Bearer token:

```bash
Authorization: Bearer <your-jwt-token>
```

---

### 📋 API Endpoints

#### **Health Check**
```http
GET /api/health
```
No authentication required. Returns database health status.

**Response:**
```json
{
  "status": "ok",
  "database": "healthy",
  "duration": 12,
  "timestamp": "2026-10-21T10:30:00.000Z"
}
```

---

#### **Users**

##### Create/Update User
```http
POST /api/v1/users
Authorization: Bearer <token>
Content-Type: application/json

{
  "externalId": "user_123",
  "name": "John Doe",
  "email": "john@example.com",
  "avatarUrl": "https://example.com/avatar.jpg",
  "metadata": { "plan": "pro" }
}
```

**Response: 201 Created**
```json
{
  "data": {
    "id": "uuid",
    "projectId": "uuid",
    "externalId": "user_123",
    "name": "John Doe",
    "email": "john@example.com",
    "avatarUrl": "https://example.com/avatar.jpg",
    "metadata": { "plan": "pro" },
    "isOnline": false,
    "createdAt": "2026-10-21T10:00:00.000Z",
    "updatedAt": "2026-10-21T10:00:00.000Z"
  }
}
```

##### List Users
```http
GET /api/v1/users?limit=50&offset=0&search=john
Authorization: Bearer <token>
```

---

#### **Conversations**

##### Create Conversation
```http
POST /api/v1/conversations
Authorization: Bearer <token>
Content-Type: application/json

{
  "type": "group",
  "title": "Project Discussion",
  "participantIds": ["user-uuid-1", "user-uuid-2"],
  "metadata": { "projectId": "proj_123" }
}
```

**Response: 201 Created**
```json
{
  "data": {
    "id": "uuid",
    "projectId": "uuid",
    "type": "group",
    "title": "Project Discussion",
    "participants": [
      {
        "id": "uuid",
        "name": "John Doe",
        "email": "john@example.com",
        "avatarUrl": "...",
        "role": "member"
      }
    ],
    "messageCount": 0,
    "isArchived": false,
    "createdAt": "2026-10-21T10:00:00.000Z"
  }
}
```

##### List Conversations
```http
GET /api/v1/conversations?type=group&limit=50&offset=0
Authorization: Bearer <token>
```

**Query Parameters:**
- `type` - `direct`, `group`, `support`
- `isArchived` - `true`, `false`
- `userId` - Filter by participant
- `limit` - Max 200, default 50
- `offset` - For pagination

---

#### **Messages**

##### Send Message
```http
POST /api/v1/messages
Authorization: Bearer <token>
Content-Type: application/json

{
  "conversationId": "conv-uuid",
  "senderId": "user-uuid",
  "content": "Hello, world!",
  "type": "text",
  "attachments": [
    {
      "type": "image",
      "url": "https://cdn.example.com/image.jpg",
      "thumbnailUrl": "https://cdn.example.com/thumb.jpg",
      "filename": "screenshot.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 204800,
      "width": 1920,
      "height": 1080
    }
  ]
}
```

**Response: 201 Created**
```json
{
  "data": {
    "id": "uuid",
    "conversationId": "uuid",
    "sender": {
      "id": "uuid",
      "name": "John Doe",
      "email": "john@example.com",
      "avatarUrl": "..."
    },
    "content": "Hello, world!",
    "type": "text",
    "attachments": [...],
    "reactionCount": 0,
    "isEdited": false,
    "isDeleted": false,
    "createdAt": "2026-10-21T10:00:00.000Z"
  }
}
```

##### List Messages
```http
GET /api/v1/messages?conversationId=<uuid>&limit=50
Authorization: Bearer <token>
```

**Query Parameters:**
- `conversationId` - **Required**
- `before` - ISO 8601 datetime
- `after` - ISO 8601 datetime
- `type` - Message type filter
- `senderId` - Filter by sender
- `limit` - Max 200, default 50

---

### 🔧 Response Format

#### Success Response
```json
{
  "data": { ... },
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 150,
    "totalPages": 3
  }
}
```

#### Error Response
```json
{
  "error": {
    "message": "Validation failed",
    "code": "VALIDATION_ERROR",
    "details": { ... }
  }
}
```

#### HTTP Status Codes
- `200` - Success
- `201` - Created
- `400` - Validation error
- `401` - Unauthorized (missing/invalid token, or the project/organization is inactive). Only authentication failures return 401.
- `403` - Forbidden
- `404` - Not found (for example, `POST /messages` to a conversation that does not exist in your project)
- `409` - Conflict
- `429` - Rate limit exceeded
- `500` - Server error (`code: INTERNAL_ERROR`, message `Internal server error`; details are logged server side, never returned). Retrying is reasonable.
- `503` - Service unavailable

---

## 🔐 Security

### API Key Management
```typescript
import { generateApiKey } from '@/lib/utils/apiKey';

const { key, prefix, hash } = generateApiKey('live');
// key: mex_live_xxxxx (give to customer)
// hash: stored in database
// prefix: for display (mex_live_abc...)
```

### JWT Authentication
```typescript
import { signToken, verifyToken } from '@/lib/auth/jwt';

const token = signToken({
  projectId: 'project-uuid',
  userId: 'user-uuid',
  type: 'user'
});
```

### Rate Limiting
Fixed-window counters in Postgres (`mx_rate_limits`), per user per route group, one atomic statement per request. It **fails open**: a limiter error or a slow database never turns a request into an error.

Roll it out in three steps, each an env change on the server: `RATE_LIMIT_MODE=dry-run` (log who *would* be blocked, for a few days), tune with `RATE_LIMITS_JSON`, then `RATE_LIMIT_MODE=enforce`. With any mode other than `off`, responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; a blocked request gets `429` with `Retry-After`.

Defaults (per user per minute): `messages` POST 120, GET 600; `uploads` 30; `uploads/presign` 60; `conversations` 120; `users` 120; everything else 300. API-type tokens (server to server) share one counter per project.

---

## 🔔 Webhooks

Set `webhook_url` (and optionally `webhook_secret`) on the organization, then run the server with `WEBHOOK_DISPATCH=on`. Events: `user.created`, `conversation.created`, `message.created` (more arrive with their endpoints). Delivery happens **after** the response, so a slow or dead receiver never delays your API call.

Each request is a `POST` with a JSON body `{ "event", "timestamp", "projectId", "data" }` and headers:

- `X-Webhook-Event`: the event name
- `X-Webhook-Signature`: `sha256=<hex HMAC-SHA256 of the raw body, keyed with the webhook secret>`

Verify it against the **raw** body (`verifyWebhookSignature` in `lib/webhooks/sender.ts`, or any HMAC-SHA256 implementation).

Every attempt is recorded in `mx_webhook_logs` (status, attempts, `next_retry_at`).

### Retries

With `WEBHOOK_RETRY=off` (default) a non-2xx response completes the row and nothing is retried. With `WEBHOOK_RETRY=on`, non-2xx responses and network errors/timeouts are retried after 1 min, 5 min, 30 min and 2 h; **5 attempts in total**, then the row is closed as exhausted. Retries re-sign the stored payload with the organization's current secret, and stop if the customer removed their `webhook_url`.

Retries are driven by a cron (nothing runs them on its own). Call once a minute:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<your-host>/api/internal/webhooks/retry
# -> {"data":{"claimed":2,"delivered":1,"rescheduled":1,"gaveUp":0,"errors":0}}
```

`GET` is accepted too (some schedulers only send GET). It is safe to run several workers at once (rows are claimed with `FOR UPDATE SKIP LOCKED` plus a 2-minute lease).
Delivery is **at least once**: make your receiver idempotent.

---

## 🔌 Realtime (Socket.IO)

Realtime runs **inside the same Node process as the API** (`server.ts`, "Path A"), so it needs a host that keeps a long-running process (VPS, Docker, Fly, Railway, Render...). It does **not** work on serverless hosts such as Vercel or Netlify. Without `REALTIME_PROVIDER=socketio` nothing realtime is loaded and the REST API is unchanged.

```bash
# development
REALTIME_PROVIDER=socketio npm run dev:socket

# production
npm run build            # next build + compiles server.ts to dist/
REALTIME_PROVIDER=socketio npm start
```

`npm start` runs the compiled `dist/server.js` (so `npm run build` must have run). It is **production** unless you pass `--dev` or set `NODE_ENV=development`, and it sets `NODE_ENV=production` itself, like `next start`. With `REALTIME_PROVIDER` unset (`none`) it serves exactly what `next start` serves, so switching a host to it is safe before you turn realtime on.

Scripts at a glance:

| Script | Runs | Use it for |
|---|---|---|
| `npm run dev` | `next dev` | REST-only development |
| `npm run dev:socket` | `tsx watch server.ts --dev` | development with realtime |
| `npm run build` | `next build` + `build:server` | production build (both parts) |
| `npm run build:next` | `next build` | REST-only hosts that never run `server.ts` |
| `npm start` | `node dist/server.js` | production (REST, plus realtime when enabled) |
| `npm run nextstart` | `next start` | the previous `start`: REST only, no `server.ts` (rollback, or serverless-style hosts) |
| `npm run start:socket` | `node dist/server.js` | alias of `npm start`, kept so older commands still work |

On Windows `cmd` use `set NAME=value` instead of the `NAME=value` prefix (PowerShell: `$env:NAME="value"`). Going live on a real host: [docs/CUTOVER_RUNBOOK.md](docs/CUTOVER_RUNBOOK.md).

### Client contract

```js
import { io } from 'socket.io-client';

const socket = io('https://your-host', {
  auth: { token },                       // the same JWT as the REST API (needs a userId to join rooms)
  transports: ['websocket'],
});

socket.emit('join-conversation', { conversationId }, (ack) => {
  // ack: { ok: true } | { ok: false, code }   code: INVALID_PAYLOAD | FORBIDDEN | RATE_LIMITED | INTERNAL_ERROR
});

socket.on('message.created', (message) => { /* same object the REST API returned */ });
socket.emit('leave-conversation', { conversationId });
```

- Connection errors carry `err.data.code`: `AUTH_REQUIRED`, `INVALID_TOKEN`, `PROJECT_INACTIVE`.
- You can only join conversations of your own project that you participate in; "not found" and "not a participant" both answer `FORBIDDEN`.
- A socket is disconnected when its token expires; reconnect with a fresh token.
- Join/leave are limited to 20 per 10 s per socket.
- Today only `message.created` is delivered in realtime (it is the only event routed to a conversation channel).

### Deploying realtime

- **Sticky sessions or websocket-only.** Socket.IO's long-polling fallback needs one client's requests to hit the same instance: use `ip_hash`/cookie affinity on the load balancer, or force `transports: ['websocket']` on clients.
- **Several instances need `REDIS_URL`.** With `REDIS_URL` set on every instance, the Socket.IO Redis adapter fans events out so a message POSTed to instance A reaches sockets on instance B (boot log: `realtime_adapter` = `redis`). Without it each instance only reaches its own sockets (`realtime_adapter` = `memory`), so keep to one instance. If Redis goes down, REST and same-instance delivery keep working and cross-instance delivery resumes by itself when Redis returns. Verify with `node scripts/test-realtime-cluster.mjs` against two running instances.
- **Graceful shutdown.** `SIGTERM`/`SIGINT` stop new connections, disconnect sockets (clients reconnect elsewhere), let in-flight webhook work finish (up to `SHUTDOWN_TIMEOUT_MS`), then exit 0. An uncaught exception exits 1 so your process manager restarts it. Run it under one (systemd, Docker restart policy, pm2...).
- **Rolling deploys.** Start the new instance, wait for `GET /api/health`, then stop the old one.

---

## 🎨 Frontend Integration Example

### React/Next.js Example

```typescript
const API_URL = 'https://your-api.com/api/v1';
const API_TOKEN = 'your-jwt-token';

// Send a message
async function sendMessage(conversationId: string, content: string) {
  const response = await fetch(`${API_URL}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      conversationId,
      senderId: 'user-uuid',
      content,
      type: 'text',
    }),
  });
  
  return response.json();
}

// Fetch messages
async function getMessages(conversationId: string) {
  const response = await fetch(
    `${API_URL}/messages?conversationId=${conversationId}&limit=50`,
    {
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
      },
    }
  );
  
  return response.json();
}
```

---

## 📊 Database Schema

See [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) for the complete schema with all tables, indexes, and relationships.

**Key Tables:**
- `organizations` - Multi-tenant accounts
- `projects` - Apps using the messaging service
- `users` - End users in each project
- `conversations` - Chat rooms/threads
- `messages` - Individual messages
- `message_attachments` - Media files
- `message_reactions` - Emoji reactions
- `mx_webhook_logs` - Event delivery tracking (all tables are prefixed `mx_`; this app can share a database with another project)

---

## 🧪 Testing

```bash
npm test                      # vitest. Tests that need Postgres run when DATABASE_URL points at a migrated,
                              # seeded database (scripts/smoke-seed.sql) and are skipped otherwise
npm run lint
npm run build                 # production build + server.ts compile
```

Verification scripts (dev/staging only, they write data; most need `JWT_SECRET` and `DATABASE_URL` and a running server):

| Script | Proves |
|---|---|
| `scripts/smoke.sh` | Every endpoint's status and response *shape* match the recorded baseline (`--record` once on a known-good build; shapes ignore ids, timestamps and how many rows came back) |
| `scripts/test-webhooks.sh` | Webhooks: no row without a `webhook_url`, signed delivery arrives, REST stays fast when the receiver fails or hangs |
| `scripts/test-realtime.mjs` | A REST `POST /messages` reaches the right sockets and nobody else (server started with `REALTIME_PROVIDER=socketio`) |
| `scripts/soak/soak.mjs` + `summarize.mjs` | Load and resource soak for realtime: REST vs `next start`, delivery, missed events, memory (see [docs/SOAK_RUNBOOK.md](docs/SOAK_RUNBOOK.md)) |
| `scripts/test-rate-limit-*.sh` | Rate limiter dry-run, enforce and cleanup |
| `scripts/verify-uploads.sh` | Upload providers (run once per provider with its real credentials) |

---

## 🚢 Deployment

### REST API only (serverless is fine)

Vercel, Netlify and similar work when you do not need realtime: they run `next build` themselves and ignore `npm start`; set the environment variables and deploy. If a host runs `npm start` instead, use `npm run nextstart` as its start command (or keep `REALTIME_PROVIDER` unset). Webhook retries then need the platform's cron to call `POST /api/internal/webhooks/retry` every minute.

### REST + realtime (long-running host)

`npm run build`, then `REALTIME_PROVIDER=socketio npm start` (see [Realtime](#-realtime-socketio) and [docs/CUTOVER_RUNBOOK.md](docs/CUTOVER_RUNBOOK.md)). Checklist:

- Rolling restart (new instance healthy on `/api/health` before the old one stops), under a process manager.
- Sticky sessions or websocket-only clients; `REDIS_URL` on every instance if you run more than one.
- A cron hitting the webhook retry route every minute if `WEBHOOK_RETRY=on`.
- Free hosting tiers that sleep, restart or reset state will drop sockets; clients reconnect automatically, but plan for it.

### Environment Variables (Production)
```env
DATABASE_URL=<supabase-pooler-connection-string>
JWT_SECRET=<secure-random-string>
APP_URL=https://your-domain.com
LOG_LEVEL=info
NODE_ENV=production
# feature flags: see the table in Configuration
```

---

## 📈 Scaling Considerations

For high-traffic applications:

1. **Use connection pooling** ✅ (Already implemented)
2. **Add Redis** for rate limiting and caching
3. **Use CDN** for media uploads (AWS S3 + CloudFront)
4. **Database read replicas** for read-heavy workloads
5. **WebSocket clustering** with the Socket.IO Redis adapter (done, Stage 5.6; set `REDIS_URL` on every instance)
6. **Message queues** for webhook delivery (Bull/BullMQ), only if the built-in cron-driven retries stop being enough

---

## 🤝 Contributing

Contributions welcome! Please read our contributing guidelines first.

---

## 📄 License

MIT License - see LICENSE file for details

---

## 🙏 Inspired By

This project is inspired by the excellent work on [global-tech-trial](https://github.com/acetennyson/global-tech-trial) and aims to provide a similar level of quality for messaging services.

---

## 📞 Support

- Documentation: [Your docs URL]
- Issues: [GitHub Issues](your-repo/issues)
- Email: support@messagingexpress.com

---

**Built with ❤️ by your team**
