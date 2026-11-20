# @messaging-express/server

The Messaging Express chat server as a library: REST API, realtime (Socket.IO), webhooks and end-to-end-encryption rules, running
inside your own Node app on your own Postgres. No Next.js. Works with Express 4 and 5, or a plain `http` server.

```bash
npm install @messaging-express/server
npx messaging-express migrate --database-url "$DATABASE_URL"   # once per deploy
```

```js
const express = require('express');
const http = require('http');
const { MessagingServer } = require('@messaging-express/server');

const chat = await MessagingServer.init({
  database: process.env.DATABASE_URL,
  jwtSecret: process.env.CHAT_JWT_SECRET, // 32+ characters
  upload: { type: 'local', options: { dir: './chat-uploads', baseUrl: 'https://api.example.com/chat' } },
});

const app = express();
chat.middleware(app, '/chat'); // mount BEFORE body parsers
const server = http.createServer(app);
await chat.attachRealtime(server);
server.listen(3000);
```

Options (authentication, participant access, E2EE, webhooks, rate limits, uploads, CORS, realtime, schema and migrations) are
documented in the repository: `docs/embedding.md`, `docs/uploads.md`, `docs/rate-limiting.md`, `docs/realtime.md`, `docs/database.md`.

Check any backend against the E2EE API contract (this module, the hosted server, or your own): `BASE_URL=… JWT_SECRET=… node node_modules/@messaging-express/server/conformance/contract.mjs`.

Optional packages, installed only if you use the feature: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (S3 uploads),
`ioredis` + `@socket.io/redis-adapter` (realtime across several instances). Requires Node 20 or newer.
