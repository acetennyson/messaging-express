# Changelog

All notable changes to `@messaging-express/client` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-26

First public release.

### Added
- `createClient` with typed requests, automatic retries for safe requests (GETs and presign) honoring `Retry-After`, and a typed `MessagingExpressError`.
- `client.uploads.upload`: parallel uploads with per-file results and progress. Direct-to-storage via presigned URL when the server supports it, falling back to the API otherwise.
- `client.messages.send` / `list`, `client.conversations.create` / `list`, `client.users.upsert` / `list`. POSTs are never retried automatically.
- `@messaging-express/client/realtime`: `createRealtime` with `connect`, `joinConversation`, `leaveConversation`, typed `message.created` events, status and error hooks, automatic reconnect and re-join, and fresh tokens on every reconnect. Requires the optional peer dependency `socket.io-client`.
- ESM and CommonJS builds with TypeScript declarations. No runtime dependencies. Node 18 or newer, and browsers.
