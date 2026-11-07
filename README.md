# Messaging Express

A multi-tenant messaging backend you run yourself: users, conversations, messages, attachments, realtime delivery, webhooks and optional end-to-end encryption, behind one REST API. It is a Next.js 16 app on Postgres, with an optional Socket.IO server for realtime.

You keep your own accounts and login. Your backend tells Messaging Express who the users are and signs a short token for each of them; the chat client then talks to the API directly.

```
 Your app (web / mobile)                 Your backend                     Messaging Express
 ───────────────────────                 ────────────                     ─────────────────
  "log me in"  ───────────────────────►  checks the login
                                         signs a token for that user ──►  (JWT, same secret)
  ◄───────────────────────────────────── returns the token
  send / read messages, listen live ──────────────────────────────────►  REST API + Socket.IO
                                         create users, read anything ──►  with an api/admin token
```

## What you get

| Area | What it does | Docs |
|---|---|---|
| Users | Create or update users by your own id (`externalId`), name, email, avatar, metadata | [API reference](docs/api-reference.md#users) |
| Conversations | Direct and group conversations, archive flag, last-message ordering, unread counters | [API reference](docs/api-reference.md#conversations) |
| Messages | Text and media messages, replies (`parentId`), attachments, newest-first paging | [API reference](docs/api-reference.md#messages) |
| Participants | Add and remove members of a conversation | [API reference](docs/api-reference.md#participants) |
| Uploads | Direct multipart upload, or presigned upload. Local disk, S3, Supabase, Firebase or your own PHP endpoint | [Uploads](docs/uploads.md) |
| Realtime | Socket.IO events for new messages and for encryption key changes. Optional, Redis for several instances | [Realtime](docs/realtime.md) |
| Webhooks | Signed HTTP callbacks (`message.created`, `conversation.created`, ...) with retry | [Webhooks](docs/webhooks.md) |
| Access control | Who may read and send, per user token. Safe rollout with a dry-run mode | [Access control](docs/access-control.md) |
| Rate limiting | Per user and per route group, in memory or Postgres, with `off`, `dry-run`, `enforce` | [Rate limiting](docs/rate-limiting.md) |
| End-to-end encryption | Optional per conversation. The server stores ciphertext only | [E2EE overview](docs/e2ee/overview.md) |
| Client SDKs | A small typed JavaScript client, and a separate crypto package for E2EE | [Packages](#packages) |

Not included, by design: user accounts and login (you bring your own), push notifications, an admin dashboard, and a self-service signup for organizations and projects (you create those with SQL, see [Getting started](docs/getting-started.md)).

## Five-minute start

You need Node 20.6 or newer (22 recommended) and a Postgres database.

```bash
git clone https://github.com/acetennyson/messaging-express.git
cd messaging-express
npm install
cp .env.example .env.local          # Windows: copy .env.example .env.local
```

Edit `.env.local` and set `DATABASE_URL` and `JWT_SECRET` (at least 32 random characters). Then:

```bash
npx tsx --env-file=.env.local scripts/migrate.ts     # creates the tables
npm run dev                                          # http://localhost:3000
curl http://localhost:3000/api/health
```

Create your first organization and project, mint a token and send a message: [Getting started](docs/getting-started.md) walks through every step with copy-paste commands and the real responses you should see.

## Documentation

Start at the [documentation index](docs/README.md). The short version:

- New here: [Getting started](docs/getting-started.md), then [Concepts](docs/concepts.md).
- Building a client: [Authentication](docs/authentication.md), [API reference](docs/api-reference.md), [Realtime](docs/realtime.md).
- Running it: [Configuration](docs/configuration.md), [Deployment](docs/deployment.md), [Troubleshooting](docs/troubleshooting.md).
- Turning on encryption: [E2EE overview](docs/e2ee/overview.md), [E2EE guide](docs/e2ee/guide.md).
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md), [Architecture](docs/architecture.md).

## Packages

| Package | What it is | Docs |
|---|---|---|
| `@messaging-express/client` | Typed JavaScript client for the REST API and realtime events. Works in browsers and Node 18+. | [packages/client](packages/client/README.md) |
| `@messaging-express/client-crypto` | End-to-end encryption for the client: device keys, per-conversation keys, encrypted messages and attachments, key backup, safety numbers. Browsers and Node 20+. | [packages/client-crypto](packages/client-crypto/README.md) |

## Repository layout

```
app/api/v1/        REST routes (users, conversations, messages, uploads, devices)
app/api/health     health check
app/api/internal   cron-style endpoints (webhook retry)
lib/               auth, database, validation, events, realtime, rate limiting, storage, E2EE rules
scripts/           migrate, token generator, smoke tests, soak and verification scripts
server.ts          production server: Next.js plus optional Socket.IO on one port
packages/          the two client packages
docs/              documentation
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server (REST only, no realtime) |
| `npm run dev:socket` | Dev server through `server.ts`, with realtime when `REALTIME_PROVIDER=socketio` |
| `npm run build` | Builds Next.js and the compiled `dist/server.js` |
| `npm start` | Runs `dist/server.js` (production; add `REALTIME_PROVIDER=socketio` for realtime) |
| `npm run nextstart` | Plain `next start` without the custom server |
| `npm test` | Server test suite (database tests are skipped without `DATABASE_URL`) |
| `npm run db:migrate` | Applies migrations. Needs `DATABASE_URL` in the real environment, see [Getting started](docs/getting-started.md#environment-variables-and-the-scripts) |

## License

MIT. See [LICENSE](LICENSE); each package carries its own LICENSE too.
