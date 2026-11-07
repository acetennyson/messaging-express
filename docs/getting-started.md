# Getting started

This page takes you from an empty machine to a first message sent through the API. It should take about ten minutes. Every response shown here was captured from a real server, so what you see should match.

**You need:** Node 20.6 or newer (22 recommended), npm, and a Postgres 13+ database you can create tables in.

- [1. Install](#1-install)
- [2. Configure](#2-configure)
- [3. Create the tables](#3-create-the-tables)
- [4. Start the server](#4-start-the-server)
- [5. Create an organization and a project](#5-create-an-organization-and-a-project)
- [6. Mint a token](#6-mint-a-token)
- [7. Send your first message](#7-send-your-first-message)
- [8. Listen live (optional)](#8-listen-live-optional)
- [Environment variables and the scripts](#environment-variables-and-the-scripts)
- [What next](#what-next)

## 1. Install

```bash
git clone https://github.com/acetennyson/messaging-express.git
cd messaging-express
npm install
```

Need a database quickly? With Docker:

```bash
docker run -d --name mx-db -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=messaging postgres:16
# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/messaging
```

## 2. Configure

```bash
cp .env.example .env.local          # Windows cmd: copy .env.example .env.local
```

Open `.env.local` and set the two values you must have:

```ini
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/messaging
JWT_SECRET=put-at-least-32-random-characters-here
```

Generate a secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

`JWT_SECRET` is the shared secret between your backend and Messaging Express: whoever has it can mint a token for any user. Keep it on servers only. Everything else has a sensible default; the full list is in [Configuration](configuration.md).

## 3. Create the tables

```bash
npx tsx --env-file=.env.local scripts/migrate.ts
```

You should see each migration run and then `All migrations completed successfully!`. The command is safe to repeat: migrations are idempotent, and you run it again after every upgrade.

> `npm run db:migrate` runs the same script but does **not** read `.env.local` (only the web server does). Use the command above, or export `DATABASE_URL` in your shell first. More in [the note at the bottom](#environment-variables-and-the-scripts).

## 4. Start the server

```bash
npm run dev
```

```bash
curl http://localhost:3000/api/health
# {"status":"ok","database":"healthy","duration":13,"timestamp":"..."}
```

If the database is unreachable the response has `"status":"degraded"` or `"unhealthy"`; see [Troubleshooting](troubleshooting.md).

`npm run dev` serves the REST API only. For realtime during development use `REALTIME_PROVIDER=socketio npm run dev:socket` (see [Realtime](realtime.md)).

## 5. Create an organization and a project

There is no signup endpoint: organizations and projects are rows you create yourself. An **organization** is the customer (it owns the webhook settings). A **project** is one app of that customer; every user, conversation and message belongs to exactly one project, and every token is tied to one.

```bash
psql "postgresql://postgres:postgres@localhost:5432/messaging"
```

```sql
INSERT INTO mx_organizations (name, slug, api_key, api_secret_hash)
VALUES ('Acme', 'acme', 'org_' || md5(random()::text), 'unused')
RETURNING id;
-- copy the id it prints: this is your ORGANIZATION_ID

INSERT INTO mx_projects (organization_id, name, api_key)
VALUES ('<ORGANIZATION_ID>', 'Acme Chat', 'proj_' || md5(random()::text))
RETURNING id;
-- copy this one too: this is your PROJECT_ID
```

`api_key` and `api_secret_hash` are required columns but the server does not use them to authenticate requests today (tokens are JWTs, see [Authentication](authentication.md)); any unique text works. Do not put a real secret in `api_secret_hash`.

## 6. Mint a token

Your backend signs tokens with `JWT_SECRET`. For this walkthrough use the helper script, which makes an **api** token (full access for your backend):

```bash
node --env-file=.env.local scripts/generate-token.js <PROJECT_ID> <ORGANIZATION_ID> api
```

Copy the token it prints and keep it in a shell variable:

```bash
export TOKEN="eyJhbGciOi..."        # PowerShell: $env:TOKEN="eyJhbGciOi..."
```

The script cannot make a *user* token (the kind a chat client uses). You will make those from your own backend; see [Authentication](authentication.md#minting-a-user-token) for code in Node, Python and PHP.

## 7. Send your first message

> **Windows:** the `curl` examples use bash quoting. In Git Bash they work as written. In PowerShell, call `curl.exe` (plain `curl` is a different command), and put the JSON in a file instead of fighting quotes: `curl.exe -X POST ... -d "@body.json"`.

Create two users. `externalId` is **your** id for the person (your database key); calling the endpoint again with the same `externalId` updates the user.

```bash
curl -s -X POST http://localhost:3000/api/v1/users \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"externalId":"alice","name":"Alice Mbah","email":"alice@example.com"}'
```

```json
{
  "data": {
    "id": "52354b46-2e75-4c63-9f8f-a01490048a3a",
    "project_id": "d26373b8-2227-40a8-936c-67d2e776f333",
    "external_id": "alice",
    "name": "Alice Mbah",
    "email": "alice@example.com",
    "avatar_url": null,
    "metadata": {},
    "is_online": false,
    "last_seen_at": null,
    "created_at": "2026-11-05T12:01:44.601Z",
    "updated_at": "2026-11-05T12:01:44.601Z"
  }
}
```

Note the shape: the API returns database rows, so field names are `snake_case`. Create a second user (`bob`) the same way, then use the two `id` values (not the `externalId`s) from here on.

Start a direct conversation between them:

```bash
curl -s -X POST http://localhost:3000/api/v1/conversations \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"direct","participantIds":["<ALICE_ID>","<BOB_ID>"]}'
```

Copy `data.id` (the conversation id). Now send a message as Alice. A chat client would use Alice's **user** token here; with the api token you may name any participant as sender:

```bash
curl -s -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"conversationId":"<CONVERSATION_ID>","senderId":"<ALICE_ID>","content":"Hello Bob"}'
```

```json
{
  "data": {
    "id": "6e08b0c6-e7a1-417b-a2e8-36ee8c2219a2",
    "conversation_id": "<CONVERSATION_ID>",
    "sender_id": "<ALICE_ID>",
    "parent_id": null,
    "content": "Hello Bob",
    "type": "text",
    "metadata": {},
    "is_edited": false,
    "is_deleted": false,
    "created_at": "2026-11-05T12:01:44.985Z",
    "updated_at": "2026-11-05T12:01:44.985Z",
    "sender": { "id": "<ALICE_ID>", "name": "Alice Mbah", "email": "alice@example.com", "avatarUrl": null },
    "attachments": []
  }
}
```

Read the conversation back (newest message first):

```bash
curl -s "http://localhost:3000/api/v1/messages?conversationId=<CONVERSATION_ID>" -H "Authorization: Bearer $TOKEN"
```

That is the whole loop. Wrong token, missing field or unknown conversation each give a specific error; the list is in the [API reference](api-reference.md#errors).

## 8. Listen live (optional)

Stop the dev server and start the realtime one:

```bash
REALTIME_PROVIDER=socketio npm run dev:socket        # PowerShell: $env:REALTIME_PROVIDER="socketio"; npm run dev:socket
```

Then, from any Node script, connect with a **user** token for Bob, join the conversation and wait for the message:

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', { auth: { token: BOB_USER_TOKEN }, transports: ['websocket'] });
socket.on('connect', () => socket.emit('join-conversation', { conversationId }, (ack) => console.log(ack)));  // { ok: true }
socket.on('message.created', (message) => console.log('new message:', message.content));
```

Post another message with `curl` and it appears in the script immediately. Details, events and error codes: [Realtime](realtime.md).

## Environment variables and the scripts

Two different things read your environment, and they behave differently:

| What | Reads `.env.local`? |
|---|---|
| `npm run dev`, `npm run build`, `npm start` | Yes for most settings (Next.js loads `.env*` files). |
| `server.ts` start-up values: `PORT`, `HOST`, `SHUTDOWN_TIMEOUT_MS`, `SOAK_STATS_INTERVAL_MS` | **No.** They are read before Next.js loads the file. Set them in the real environment (`PORT=4000 npm start`, or your host's settings). |
| `scripts/migrate.ts`, `scripts/generate-token.js` and the other scripts | **No**, unless you pass `--env-file`. |

So for scripts, either pass the file (Node 20.6+):

```bash
npx tsx --env-file=.env.local scripts/migrate.ts
node --env-file=.env.local scripts/generate-token.js <PROJECT_ID> <ORGANIZATION_ID> api
```

or export the variables in your shell first (`export DATABASE_URL=...`, PowerShell `$env:DATABASE_URL="..."`, cmd `set DATABASE_URL=...`). In production you set real environment variables anyway.

## What next

- Understand the model: [Concepts](concepts.md).
- Build the client side: [Authentication](authentication.md), then the [JavaScript client](../packages/client/README.md).
- Lock down who can read what before real users arrive: [Access control](access-control.md).
- Put it on a server: [Deployment](deployment.md).
