# API reference

Base URL: `https://<your-host>/api/v1`. All routes need `Authorization: Bearer <token>` (see [Authentication](authentication.md)), send and receive JSON, and are covered by [rate limits](rate-limiting.md). Encryption routes (`/devices...`, `/conversations/:id/keys`, ...) are documented in the [E2EE API](e2ee/api.md).

**Contents:** [Conventions](#conventions) · [Users](#users) · [Conversations](#conversations) · [Participants](#participants) · [Messages](#messages) · [Uploads](#uploads) · [Health and internal routes](#health-and-internal-routes) · [Errors](#errors) · [What the API does not do yet](#what-the-api-does-not-do-yet)

## Conventions

**Success**

```json
{ "data": { } }                                                        // one object
{ "data": [ ], "meta": { "limit": 50, "page": 1, "total": 4, "totalPages": 1 } }   // a list
```

**Paging.** List routes take `limit` (1 to 200, default 50) and `offset` (default 0). `meta.page` is `floor(offset / limit) + 1`. `GET /messages` returns only `limit` and `page` in `meta` (no total). On `GET /users` the `total` counts every user in the project, even when you filter with `search` or `externalId`.

**Field names.** Rows are returned as stored: `snake_case`. Nested objects built by the API (`sender`, `participants`, `attachments`) use `camelCase`. Counts (`participant_count`, `message_count`, `reaction_count`) are strings.

**Who can call what.** "Any token" means a user, api or admin token of the project. Where a user token is treated differently, it says so, and [Access control](access-control.md) has the full rules.

**Body size.** JSON bodies are limited to 256 KiB by default (`MAX_JSON_BODY_BYTES`), otherwise `413 PAYLOAD_TOO_LARGE`. File uploads have their own limit.

## Users

### `POST /users`: create or update a user

| Field | Type | Notes |
|---|---|---|
| `name` | string, 1 to 255 | required |
| `externalId` | string, 1 to 255 | your id for the person. If a user with this `externalId` exists in the project, it is **replaced**. Without it, a new user is created every time. |
| `email` | string (email) | optional |
| `avatarUrl` | string (URL) | optional |
| `metadata` | object | optional, free-form |

```bash
curl -X POST $BASE/users -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"externalId":"alice","name":"Alice Mbah","email":"alice@example.com","metadata":{"plan":"pro"}}'
```

Returns `201` with the user row:

```json
{ "data": { "id": "52354b46-...", "project_id": "d26373b8-...", "external_id": "alice", "name": "Alice Mbah",
            "email": "alice@example.com", "avatar_url": null, "metadata": { "plan": "pro" },
            "is_online": false, "last_seen_at": null, "created_at": "...", "updated_at": "..." } }
```

It is `201` even when an existing user was updated. Sending the same `externalId` again with only `name` resets `email` to `null` and `metadata` to `{}`: **always send the whole record.** Triggers the `user.created` or `user.updated` [webhook](webhooks.md).

### `GET /users`: list users

Query: `limit`, `offset`, `search` (case-insensitive match on name or email), `externalId` (exact match). Newest first.

```bash
curl "$BASE/users?externalId=alice" -H "Authorization: Bearer $TOKEN"
```

Typical use: find the Messaging Express `id` for one of your own users. This route is a project-wide directory: any token in the project can list all users.

## Conversations

### `POST /conversations`: create

| Field | Type | Notes |
|---|---|---|
| `type` | `direct` \| `group` \| `support` | required; a label for your UI |
| `participantIds` | array of user ids (UUID) | required, at least 1, no duplicates, every id must be a user of this project |
| `title` | string, max 255 | optional |
| `metadata` | object | optional |
| `encryptionMode`, `keys`, `id` | | only for encrypted conversations, see the [E2EE API](e2ee/api.md#create-an-encrypted-conversation) |

```bash
curl -X POST $BASE/conversations -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"group","title":"Team","participantIds":["<ALICE_ID>","<BOB_ID>"],"metadata":{"topic":"launch"}}'
```

Returns `201`:

```json
{ "data": {
    "id": "93b20463-fc19-44b0-8836-ccb767d9b534", "project_id": "d26373b8-...", "type": "group", "title": "Team",
    "metadata": { "topic": "launch" }, "is_archived": false, "last_message_at": null,
    "created_at": "...", "updated_at": "...", "encryption_mode": "none", "min_key_version": 1,
    "participants": [
      { "id": "52354b46-...", "name": "Alice Mbah", "email": null, "avatarUrl": null, "role": "member" },
      { "id": "22dad09a-...", "name": "Bob Tabi",   "email": null, "avatarUrl": null, "role": "member" }
    ] } }
```

Errors: `400` for duplicate ids (`participantIds must be unique`) or an id that is not a user of this project (`One or more participantIds are not users of this project`). Triggers the `conversation.created` webhook. There is no realtime event for it: tell your users' clients through your own channel.

### `GET /conversations`: list

Query: `limit`, `offset`, `type`, `isArchived` (`true` or `false`), `userId` (only conversations this user is in). Sorted by `last_message_at`, newest first (conversations with no messages last).

```json
{ "data": [ { "id": "f1ba8964-...", "type": "direct", "title": null, "metadata": {}, "is_archived": false,
              "last_message_at": "2026-11-05T12:01:45.238Z", "encryption_mode": "none", "min_key_version": 1,
              "participant_count": "2", "message_count": "5", "...": "..." } ],
  "meta": { "limit": 1, "page": 1, "total": 4, "totalPages": 4 } }
```

For a **user token**: with `PARTICIPANT_ACCESS_MODE=enforce` only the caller's own conversations are returned (and `?userId=<someone else>` is `403`); encrypted conversations the caller is not in are never listed. API and admin tokens see everything. See [Access control](access-control.md).

The list does not include the participants or unread counts. Use `POST /conversations` (which returns the participants), your own records, or the `conversation.created` webhook for that.

## Participants

### `POST /conversations/:id/participants`: add a member

Body: `{ "userId": "<uuid>" }`. Allowed for a current participant, or an api/admin token.

- `201` with the participant when added, `200` when already a member (idempotent).
- In an encrypted conversation the new member must already have a registered device, otherwise `409 PARTICIPANT_HAS_NO_DEVICE`.
- A user token that is not a participant gets `403`; a `userId` that is not a user of this project gets `404 User not found`.

```json
{ "data": { "conversationId": "...", "userId": "..." } }
```

### `DELETE /conversations/:id/participants/:userId`: remove a member

Allowed for any current participant (so anyone can remove anyone, including themselves) and for api/admin tokens. `404 Participant not found` if that user is not a participant.

```json
{ "data": { "conversationId": "...", "userId": "...", "minKeyVersion": null } }
```

In an encrypted conversation the same transaction forces a key rotation, and `minKeyVersion` is the new minimum (see [E2EE guide](e2ee/guide.md#membership-changes)). A removed user's live sockets leave the conversation room immediately, so they stop receiving messages even in a plain conversation.

## Messages

### `POST /messages`: send

| Field | Type | Notes |
|---|---|---|
| `conversationId` | UUID | required |
| `senderId` | UUID | required; must be a participant. A user token must be this user (see below). |
| `content` | string | optional (a message may be only attachments). Unbounded apart from the 256 KiB body limit. |
| `type` | `text` \| `image` \| `video` \| `file` \| `system` | default `text`; a label for your UI |
| `parentId` | UUID | marks a reply. Stored as given; not checked against the conversation. |
| `metadata` | object | free-form |
| `attachments` | array | each: `type` (`image`, `video`, `file`), `url` (required), and optional `thumbnailUrl`, `filename`, `mimeType`, `sizeBytes`, `width`, `height`, `durationSeconds`, `metadata` |

```bash
curl -X POST $BASE/messages -H "Authorization: Bearer $USER_TOKEN" -H "Content-Type: application/json" -d '{
  "conversationId":"<CONVERSATION_ID>","senderId":"<MY_USER_ID>","content":"Lunch?"}'
```

A reply with an image (the `url` comes from [Uploads](uploads.md) or any public URL):

```json
{ "conversationId": "...", "senderId": "...", "content": "Yes", "parentId": "<MESSAGE_ID>", "type": "image",
  "attachments": [ { "type": "image", "url": "https://cdn.example.com/menu.jpg", "filename": "menu.jpg",
                     "mimeType": "image/jpeg", "sizeBytes": 20480, "width": 800, "height": 600 } ] }
```

Returns `201` with the message, its `sender` and its `attachments`:

```json
{ "data": { "id": "6e08b0c6-...", "conversation_id": "...", "sender_id": "...", "parent_id": null, "content": "Hello Bob",
            "type": "text", "metadata": {}, "is_edited": false, "edited_at": null, "is_deleted": false, "deleted_at": null,
            "created_at": "...", "updated_at": "...",
            "sender": { "id": "...", "name": "Alice Mbah", "email": "alice@example.com", "avatarUrl": null },
            "attachments": [] } }
```

Side effects, all in one transaction: the conversation's `last_message_at` is set, and `unread_count` goes up for every other participant. After the response: `message.created` is sent to the conversation's realtime room and to the webhook.

Errors: `404` conversation not found in your project; `400` sender is not a participant; `403` a user token tried to send as someone else (see [Access control](access-control.md)); `429` rate limited. In an encrypted conversation the message must be well-formed ciphertext, see the [E2EE API](e2ee/api.md#messages-in-an-encrypted-conversation).

### `GET /messages`: list a conversation's messages

Query: `conversationId` (required), `limit`, `offset`, `before` and `after` (ISO 8601 timestamps on `created_at`), `type`, `senderId`. **Newest first.**

```bash
curl "$BASE/messages?conversationId=<ID>&limit=20" -H "Authorization: Bearer $USER_TOKEN"
```

Each item is shaped like the `POST` response plus `reaction_count` (a string, always `"0"` today: reactions have no endpoint yet). To page backwards through history, pass the `created_at` of the oldest message you have as `before`; that is more stable than `offset` while new messages arrive.

A conversation id that is not in your project returns an empty list. With participant access enforced (always for encrypted conversations), a user who is not a member gets `403`.

## Uploads

Upload files first, then reference the returned URLs in a message's `attachments`. Full guide: [Uploads](uploads.md).

### `POST /uploads`: upload through the server

`multipart/form-data` with one or more `file` fields and an optional `category` field.

```bash
curl -X POST $BASE/uploads -H "Authorization: Bearer $TOKEN" -F "file=@note.pdf" -F "file=@photo.png"
```

```json
{ "data": [ { "filename": "note.pdf", "type": "file", "mimeType": "application/pdf", "sizeBytes": 5,
              "url": "http://localhost:3000/uploads/<uuid>-note.pdf" },
            { "filename": "x.zip", "mimeType": "application/zip", "error": "File type not allowed: application/zip" } ] }
```

The status is `200` even if every file failed: check each item for `error`. Allowed types by default: JPEG, PNG, GIF, WebP, MP4, WebM and PDF, up to 25 MB each (configurable).

### `POST /uploads/presign`: get a direct upload URL

Body: `{ "filename", "mimeType", "sizeBytes", "category"? }`. Returns the URL, method and headers to upload straight to the storage provider (S3, Supabase, Firebase), plus the `publicUrl` to use afterwards. `501 PRESIGN_NOT_SUPPORTED` for the `local` and `php` providers: fall back to `POST /uploads`.

## Health and internal routes

| Route | Purpose |
|---|---|
| `GET /api/health` | No auth. `{"status":"ok","database":"healthy","duration":13,"timestamp":"..."}`; When the database is unreachable it answers `503` with `{"status":"error","database":"unhealthy"}`, and `503` with `{"status":"degraded","database":"slow"}` when the check takes over 2 seconds. Use it for load balancers and container health checks. |
| `POST` or `GET /api/internal/webhooks/retry` | Retry worker for failed webhooks. Authenticated with `Authorization: Bearer $CRON_SECRET`, not a JWT. See [Webhooks](webhooks.md#retries). |
| `GET /uploads/<file>` | Serves files stored by the `local` storage provider. Public, no auth, cached for a year. |

## Errors

Every error is JSON with the same shape:

```json
{ "error": { "message": "Conversation not found", "code": "NOT_FOUND" } }
```

Some add `"details"` (for example `STALE_DEVICE_SET` lists the current device ids).

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad or missing field, malformed JSON, sender is not a participant, unknown participant ids. For schema errors `message` is the list of validation issues serialized as JSON text, with each field in `path`. |
| 401 | `UNAUTHORIZED` | Missing, invalid or expired token; inactive project or organization. See [Authentication](authentication.md#authentication-errors). |
| 403 | `FORBIDDEN` | Valid token, not allowed: not a participant, user token acting for someone else, admin-only route. |
| 404 | `NOT_FOUND` | Conversation or participant not found in your project. Encryption routes answer `404` for everything while `E2EE_ENABLED` is off. |
| 409 | `CONFLICT` | A unique value already exists (`Resource already exists`). Encryption routes add more `409` codes. |
| 413 | `PAYLOAD_TOO_LARGE` | JSON body above `MAX_JSON_BODY_BYTES`. |
| 429 | `RATE_LIMIT_EXCEEDED` | Over the limit with `RATE_LIMIT_MODE=enforce`. Honour the `Retry-After` header (seconds). |
| 500 | `INTERNAL_ERROR` | Unexpected failure (including the database being down). The message is always the generic `Internal server error`; the details are in the server log only. |
| 500 | `STORAGE_MISCONFIGURED` | The selected storage provider is missing settings. |

Rate-limited responses (and, when `RATE_LIMIT_MODE` is not `off`, all authenticated ones) carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (a Unix timestamp in seconds).

## What the API does not do yet

So you do not look for it: there are no endpoints to edit or delete a message, add reactions, send typing indicators, mark a conversation as read (the unread counter only goes up), archive or rename a conversation, fetch one conversation or its participant list (outside encrypted conversations), or update presence. The database has tables for some of these (reactions, typing indicators) and the validation schemas exist, but no route uses them. Webhook event names such as `message.updated` and `user.online` are reserved and never sent today.
