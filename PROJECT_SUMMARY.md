# Messaging Express - Project Summary

## 🎯 What Is This?

**Messaging Express** is a complete **Messaging-as-a-Service (MAAS)** platform that developers can integrate into their applications for customer support, in-app messaging, or any real-time communication needs.

**Inspired by**: [global-tech-trial](https://github.com/acetennyson/global-tech-trial)  
**Built with**: Next.js 16, TypeScript, PostgreSQL, JWT Auth, Socket.IO (optional Redis)

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it works today and [`docs/ENGINEERING_LOG.md`](docs/ENGINEERING_LOG.md) for how it got here.

---

## ✅ What's Been Built

### Core Infrastructure ✅

- ✅ **Multi-tenant architecture** (Organizations → Projects → Users)
- ✅ **JWT authentication** with middleware
- ✅ **PostgreSQL database** with connection pooling
- ✅ **Database migrations** (13 tables, all indexes)
- ✅ **Structured JSON logging** with sensitive data redaction
- ✅ **Standard API response format**
- ✅ **CORS support** with configurable origins
- ✅ **Request validation** with Zod schemas

### API Endpoints ✅

#### Users
- ✅ `POST /api/v1/users` - Create/update user (upsert)
- ✅ `GET /api/v1/users` - List users with search & pagination

#### Conversations
- ✅ `POST /api/v1/conversations` - Create conversation (direct/group/support)
- ✅ `GET /api/v1/conversations` - List conversations with filters

#### Messages
- ✅ `POST /api/v1/messages` - Send message with attachments
- ✅ `GET /api/v1/messages` - Fetch messages with pagination & filters

#### Uploads
- ✅ `POST /api/v1/uploads` - Server-side multipart upload (providers: local, S3, Supabase, Firebase, PHP)
- ✅ `POST /api/v1/uploads/presign` - Presigned direct upload (`501` for providers that cannot)

#### Operations
- ✅ `GET /api/health` - Database health check (`503` when unreachable or slow)
- ✅ `POST /api/internal/webhooks/retry` - Cron-driven webhook retries (`CRON_SECRET`)

### Features Implemented ✅

- ✅ **Message types**: text, image, video, file, system
- ✅ **Message attachments** with metadata (size, dimensions, duration)
- ✅ **Message threading** (parent/child replies)
- ✅ **Conversation types**: direct, group, support
- ✅ **Participant management** with roles
- ✅ **Unread counts** auto-updated
- ✅ **Last message tracking** per conversation
- ✅ **Metadata support** on all entities
- ✅ **Transaction support** for data integrity
- ✅ **External ID mapping** for user systems

### Platform Features ✅ (added by the staged plan)

- ✅ **Rate limiting** (Postgres, fixed window, per project and user): `RATE_LIMIT_MODE=off|dry-run|enforce`, fails open
- ✅ **Webhooks**: HMAC-SHA256 signed, logged in `mx_webhook_logs`, `WEBHOOK_DISPATCH` flag
- ✅ **Webhook retries**: backoff 1 min / 5 min / 30 min / 2 h, claim-with-lease, `WEBHOOK_RETRY` flag
- ✅ **Realtime (Socket.IO, Path A)**: JWT handshake, conversation rooms, `message.created` pushed to participants, `REALTIME_PROVIDER=socketio`
- ✅ **Multi-instance realtime**: Redis adapter via `REDIS_URL` (degrades to per-instance if Redis is down)
- ✅ **Custom server** (`server.ts`): graceful shutdown, in-flight draining, soak tooling and runbooks
- ✅ **Uploads**: pluggable storage providers
- ✅ **Correct error contract**: 401 only for authentication failures, 404 for missing conversation on send, generic 500 (no internal text leaked) on the messages route
- ✅ **Optional project-lookup cache**: `PROJECT_CACHE_TTL_SECONDS`
- ✅ **Test suite**: vitest, real Postgres and real sockets where it matters; smoke, webhook, realtime and cluster scripts

### Security ✅

- ✅ JWT authentication
- ✅ Project-level isolation
- ✅ Participant authorization
- ✅ Password hashing (bcrypt ready)
- ✅ API key generation utilities
- ✅ Webhook signature verification
- ✅ Sensitive data redaction in logs

### Documentation ✅

- ✅ **README.md** - Complete project documentation
- ✅ **SETUP_GUIDE.md** - Step-by-step setup instructions
- ✅ **ARCHITECTURE.md** - How the system works today
- ✅ **CHANGELOG.md** - API behaviour changes
- ✅ **docs/** - Engineering log, cutover and soak runbooks
- ✅ **DATABASE_SCHEMA.md** - Full database schema
- ✅ **API_EXAMPLES.md** - Comprehensive API examples
- ✅ **CONTRIBUTING.md** - Contribution guidelines
- ✅ **PROJECT_SUMMARY.md** - This document

### Developer Tools ✅

- ✅ Database migration script (`npm run db:migrate`)
- ✅ JWT token generator (`scripts/generate-token.js`)
- ✅ Environment configuration (`.env.example`)
- ✅ TypeScript configuration
- ✅ Modern landing page

---

## 📦 Project Structure

```
messaging-express/
├── app/
│   ├── api/
│   │   ├── v1/{users,conversations,messages,uploads,uploads/presign}/route.ts
│   │   ├── internal/webhooks/retry/route.ts   (cron)
│   │   └── health/route.ts
│   ├── uploads/[...path]/route.ts             (serves local uploads)
│   └── layout.tsx, page.tsx                   (landing page)
├── lib/
│   ├── auth/            jwt.ts, middleware.ts, project.ts
│   ├── config/          flags.ts (request-time feature flags)
│   ├── cors/            index.ts
│   ├── db/              pool.ts
│   ├── errors.ts        typed errors and status mapping
│   ├── events/          emit.ts, inflight.ts
│   ├── http.ts          response helpers
│   ├── logger/          index.ts
│   ├── rate-limit/      limiter, limits, providers/postgres.ts
│   ├── realtime/        registry, types, providers/{socketio,redis}.ts
│   ├── storage/         providers/{local,s3,supabase,firebase,php}.ts
│   ├── utils/           apiKey.ts, concurrency.ts
│   ├── validation/      schemas.ts
│   ├── webhooks/        sender.ts, retry.ts, backoff.ts
│   └── client/          uploadClient.ts (browser helper; to be superseded by the SDK)
├── server.ts            custom entrypoint (Next + Socket.IO, graceful shutdown)
├── scripts/             migrate.ts, smoke.sh, test-*.sh|mjs, soak/, generate-token.js
├── docs/                ENGINEERING_LOG.md, CUTOVER_RUNBOOK.md, SOAK_RUNBOOK.md
└── *.md                 README, ARCHITECTURE, SETUP_GUIDE, DATABASE_SCHEMA, API_EXAMPLES, CHANGELOG, CONTRIBUTING
```

---

## 🚀 Roadmap

### Done from the original Phase 2
- ✅ WebSocket real-time messaging (Socket.IO, Redis adapter for several instances)
- ✅ Rate limiting (Postgres store; a Redis store is a possible later swap)
- ✅ Media upload with presigned URLs and several storage providers
- ✅ Webhook retries with exponential backoff

### Next
1. **Client SDK** (`packages/*`): scaffold and uploads, REST wrappers, realtime, publishing. Not started.
2. **Realtime paths B and C**: separate realtime service with Redis, or a hosted provider (Pusher, Ably, Supabase).
3. **Error-contract cleanup** for the remaining `app/api/v1/*` routes (they still return 400 for everything).
4. **Realtime coverage**: only `message.created` is pushed; typing, presence, reactions and other events are not.

### Still to build
- Message reactions, edit and delete endpoints (tables exist), typing indicators endpoint
- Full-text search; admin panel; analytics and usage quotas
- Read replicas, partitioning, CDN for media
- Voice, video calls, templates, chatbots
- End-to-end encryption (`REDESIGN.md` section 9 is the next roadmap item)

---

## 🗄️ Database Tables (13 tables, all prefixed `mx_`)

| Table | Purpose | Status |
|-------|---------|--------|
| `mx_organizations` | Top-level accounts | ✅ |
| `mx_projects` | Apps using the service | ✅ |
| `mx_users` | End users in each project | ✅ |
| `mx_conversations` | Chat rooms/threads | ✅ |
| `mx_conversation_participants` | Who's in each conversation | ✅ |
| `mx_messages` | Individual messages | ✅ |
| `mx_message_attachments` | Media files | ✅ |
| `mx_message_reactions` | Emoji reactions | ✅ |
| `mx_typing_indicators` | Real-time typing status | ✅ |
| `mx_webhook_logs` | Webhook delivery tracking | ✅ |
| `mx_rate_limits` | Rate limiting counters | ✅ |
| `mx_api_keys` | API key management | ✅ |
| `mx_analytics_events` | Usage tracking | ✅ |

---

## 📊 API Coverage

| Feature | Endpoint | Method | Status |
|---------|----------|--------|--------|
| Health Check | `/api/health` | GET | ✅ |
| Create User | `/api/v1/users` | POST | ✅ |
| List Users | `/api/v1/users` | GET | ✅ |
| Create Conversation | `/api/v1/conversations` | POST | ✅ |
| List Conversations | `/api/v1/conversations` | GET | ✅ |
| Send Message | `/api/v1/messages` | POST | ✅ |
| List Messages | `/api/v1/messages` | GET | ✅ |
| Upload File | `/api/v1/uploads` | POST | ✅ |
| Presign Upload | `/api/v1/uploads/presign` | POST | ✅ |
| Retry Webhooks (cron) | `/api/internal/webhooks/retry` | POST | ✅ |
| Add Reaction | `/api/v1/reactions` | POST | 📝 TODO |
| Remove Reaction | `/api/v1/reactions` | DELETE | 📝 TODO |
| Update Message | `/api/v1/messages/:id` | PATCH | 📝 TODO |
| Delete Message | `/api/v1/messages/:id` | DELETE | 📝 TODO |
| Typing Indicator | `/api/v1/typing` | POST | 📝 TODO |

---

## 🧪 Testing Status

| Type | Status |
|------|--------|
| Unit tests | ✅ vitest (`npm test`) |
| Integration tests | ✅ real Postgres (retry, rate limit, messages route, Socket.IO provider); Redis suite runs when `REDIS_URL` is set |
| API contract | ✅ `scripts/smoke.sh` (response-shape baselines) |
| Webhooks and realtime end to end | ✅ `scripts/test-webhooks.sh`, `test-realtime.mjs`, `test-realtime-cluster.mjs` |
| Soak | 🔄 tooling and runbook ready; multi-day staging soak is an operator task |
| Load tests | 📝 TODO |

**Test Framework**: Vitest

---

## 📈 Performance Targets

| Metric | Target | Current |
|--------|--------|---------|
| API Latency (P95) | <100ms | ⏱️ Not measured |
| Database Queries | <50ms | ⏱️ Not measured |
| Concurrent Users | 10,000+ | 🔄 Not tested |
| Messages/Second | 1,000+ | 🔄 Not tested |
| Uptime | 99.9% | ⏱️ Not deployed |

---

## 🔧 Configuration

### Required Environment Variables

```env
DATABASE_URL=<postgres-connection-string>
JWT_SECRET=<random-secure-string>
```

### Optional Environment Variables

```env
APP_URL=http://localhost:3000
LOG_LEVEL=info
CORS_ALLOWED_ORIGINS=*
WEBHOOK_TIMEOUT_MS=5000
# Feature flags (all default to the old behaviour): see README.md and .env.example
RATE_LIMIT_MODE=off            # off | dry-run | enforce
WEBHOOK_DISPATCH=off           # on to send webhooks
WEBHOOK_RETRY=off              # on to retry failures (needs CRON_SECRET and a cron)
REALTIME_PROVIDER=none         # socketio for WebSockets
REDIS_URL=                     # same value on every instance; rediss:// for TLS (e.g. Upstash)
PROJECT_CACHE_TTL_SECONDS=0    # 0 = off
```

---

## 💰 Cost Estimation (Monthly)

| Service | Tier | Cost |
|---------|------|------|
| Supabase | Free | $0 |
| Vercel | Hobby | $0 |
| **Total** | | **$0** |

For production scale:
- Supabase Pro: ~$25/mo
- Vercel Pro: ~$20/mo
- S3 Storage: ~$5/mo
- Redis: ~$10/mo
- **Total**: ~$60/mo

---

## 🎓 Learning Resources

- [Next.js 16 Docs](https://nextjs.org/docs)
- [PostgreSQL Docs](https://www.postgresql.org/docs/)
- [Supabase Docs](https://supabase.com/docs)
- [JWT.io](https://jwt.io/)
- [Zod Docs](https://zod.dev/)

---

## 🤝 Similar Projects

- [global-tech-trial](https://github.com/acetennyson/global-tech-trial) - Task management API (inspiration)
- [Sendbird](https://sendbird.com/) - Commercial messaging platform
- [Stream Chat](https://getstream.io/chat/) - Commercial messaging API
- [Matrix](https://matrix.org/) - Open federated messaging

---

## ✨ Key Differentiators

1. **Open Source** - Full control, no vendor lock-in
2. **Multi-Tenant** - Built for SaaS from day one
3. **Modern Stack** - Next.js 16, TypeScript, latest patterns
4. **Production-minded** - Transactions, structured logging, typed errors, graceful shutdown, feature flags with rollback
5. **Well Documented** - 8 comprehensive docs, code examples
6. **Developer First** - Clean API, sensible defaults, easy setup

---

## 📝 Notes

- This is a **v1.0 foundation** - core features are solid, advanced features planned
- The codebase follows **best practices** from the reference project
- **Security** is baked in, not an afterthought
- **Scalability** is considered in the design (pooling, indexes, etc.)
- Realtime, rate limiting and webhooks with retries are in; **before production** finish the staging soak (`docs/SOAK_RUNBOOK.md`) and follow `docs/CUTOVER_RUNBOOK.md`

---

## 🎉 Conclusion

You now have a **professional-grade messaging API** that rivals commercial offerings. It's:

- ✅ **Feature-complete** for basic messaging
- ✅ **Well-architected** for scale
- ✅ **Fully documented** for developers
- ✅ **Production-minded**: graceful shutdown, flags with rollback, tested failure modes
- ✅ **Open source** and MIT licensed

**Next**: run the soak, deploy with the cutover runbook, then build the client SDK. 🚀

---

**Built with ❤️ - October 2026**
