# Changelog

All notable changes to the server. The npm packages keep their own changelogs (`packages/client/CHANGELOG.md`).

## Unreleased

### Added
- **End-to-end encryption** (off by default, `E2EE_ENABLED`). Device registry, device pairing and linking, encrypted conversations with per-device wrapped keys, enforced key rotation on member removal, encrypted attachments (`category=e2ee`), passphrase-encrypted key backup, admin device reset, and realtime events for devices, keys and membership. Every encryption route answers `404` while the switch is off. See [docs/e2ee](docs/e2ee/overview.md).
- `GET /conversations/:id/devices`: the active devices of an encrypted conversation's current participants.
- `POST /conversations` accepts an optional client-chosen `id` (UUID) for encrypted conversations (`409 CONVERSATION_EXISTS` if taken); ignored for plain conversations.
- **Participant routes:** `POST /conversations/:id/participants` and `DELETE /conversations/:id/participants/:userId`. They work on plain conversations too, regardless of the encryption switch. Removing a user also removes their live sockets from the conversation's realtime room.
- **`PARTICIPANT_ACCESS_MODE`** (`off` default, `dry-run`, `enforce`): limits user tokens to conversations they belong to, to their own listing, and to sending as themselves. API and admin tokens are never restricted. Encrypted conversations are always enforced. See [Access control](docs/access-control.md).
- Realtime: user tokens automatically join a personal room `user:<userId>` after the handshake.
- **Rate limiting** (`RATE_LIMIT_MODE`: `off` default, `dry-run`, `enforce`), Postgres-backed, with `X-RateLimit-*` and `Retry-After` headers and `RATE_LIMITS_JSON` overrides.
- **Webhooks** (`WEBHOOK_DISPATCH`) with HMAC-SHA256 signatures, a delivery log, and optional retries (`WEBHOOK_RETRY`) at 1 minute, 5 minutes, 30 minutes and 2 hours, driven by `POST /api/internal/webhooks/retry` and `CRON_SECRET`.
- **Realtime** over Socket.IO (`REALTIME_PROVIDER=socketio`) with optional Redis for several instances, graceful shutdown, and `SOAK_STATS_INTERVAL_MS` runtime stats.
- Storage providers: local, S3 (and S3-compatible), Supabase, Firebase, PHP; direct uploads through presigned URLs where supported.
- `PROJECT_CACHE_TTL_SECONDS`: optional cache of the project lookup that runs on every request.
- Docker image, `docker-compose.yml` with Postgres and Redis, and a health check.
- `GET /api/health`.
- Client SDK (`@messaging-express/client`) and encryption package (`@messaging-express/client-crypto`).

### Changed
- **Error status codes.** Clients that branch on HTTP status should review this.

  | Situation | Before | Now |
  |---|---|---|
  | A handler throws unexpectedly (bug, database error) | `401` with the internal error text | `500 INTERNAL_ERROR`, message `Internal server error` |
  | Database fails while authenticating | `401` | `500 INTERNAL_ERROR` |
  | `POST /messages`, conversation not in your project | `400` | `404 NOT_FOUND` |
  | `POST /messages`, unexpected failure | `400` with internal text | `500 INTERNAL_ERROR` |
  | `GET /users`, `GET /conversations`, `GET /messages`, `POST /users`, `POST /conversations`: database failure | `400` with internal text | `500 INTERNAL_ERROR` |
  | `GET /users`: `limit` or `offset` not a number, or `limit` outside 1 to 200 | database error text, or accepted | `400 VALIDATION_ERROR` |
  | `POST /conversations`: duplicate `participantIds` | `400` with database text | `400`, `participantIds must be unique` |
  | `POST /conversations`: unknown participant id | `400` with database text | `400`, `One or more participantIds are not users of this project` |
  | Any route: unique constraint violated | `400` with constraint text | `409 CONFLICT`, `Resource already exists` |

  Unchanged: missing or invalid token and inactive project or organization (`401`), schema validation and "sender is not a participant" (`400`), rate limiting (`429`). Internal error messages (for example connection strings) are no longer sent to clients.
- `GET` and `POST /conversations` now include `encryption_mode` (`"none"` by default) and `min_key_version` (`1`) on each conversation.
- **Logging redaction** is case-insensitive and applies at any depth (previously only top-level `password`, `token`, `apiKey`, `secret`); encryption blobs and keys are redacted too. Objects nested deeper than 6 levels are logged as `[Truncated]`.
- `npm start` runs the compiled custom server (`node dist/server.js`). The previous behaviour is `npm run nextstart`.

### Security
- **Request body limit.** JSON bodies are read with a hard limit (`MAX_JSON_BODY_BYTES`, default 262144 bytes), before anything parses them; larger bodies get `413 PAYLOAD_TOO_LARGE`. A single very large request used to be able to keep a server busy for seconds and grow its memory by about 1 GB. **Before deploying**, raise the limit if any client legitimately sends more than 256 KiB of JSON. Multipart uploads are not covered.
- `POST /conversations` rejected nothing when a participant belonged to a **different project**; it now returns `400`. Conversations created earlier may already contain such participants: find them with
  ```sql
  SELECT cp.conversation_id, cp.user_id
  FROM mx_conversation_participants cp
  JOIN mx_conversations c ON c.id = cp.conversation_id
  JOIN mx_users u ON u.id = cp.user_id
  WHERE u.project_id <> c.project_id;
  ```
- User tokens used to be able to list every conversation, read any conversation's messages and send as any participant. `PARTICIPANT_ACCESS_MODE` and the always-on checks for encrypted conversations close this (see above).

### Fixed
- The server no longer exits when an idle database connection errors.
- A connection reset on a checked-out database client no longer crashes the server (it is now a failed request); a failed rollback no longer hides the original error.
- `GET /conversations?isArchived=true|false` answered `400` on older servers; the query string is now parsed correctly.
