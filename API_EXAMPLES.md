# Messaging Express - API Examples

Complete collection of API examples for Messaging Express.

## Table of Contents

1. [Authentication](#authentication)
2. [Users](#users)
3. [Conversations](#conversations)
4. [Messages](#messages)
5. [Reactions](#reactions)
6. [Media Upload](#media-upload)
7. [Error Handling](#error-handling)

---

## Authentication

All API requests require a Bearer token in the Authorization header.

```bash
Authorization: Bearer <your-jwt-token>
```

### Generate a Token (Development)

```javascript
const jwt = require('jsonwebtoken');

const token = jwt.sign({
  projectId: 'your-project-id',
  organizationId: 'your-org-id',
  type: 'api'
}, process.env.JWT_SECRET, { expiresIn: '7d' });

console.log(token);
```

---

## Users

### Create or Update a User

**Endpoint**: `POST /api/v1/users`

```bash
curl -X POST http://localhost:3000/api/v1/users \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "user_12345",
    "name": "Alice Johnson",
    "email": "alice@example.com",
    "avatarUrl": "https://example.com/avatars/alice.jpg",
    "metadata": {
      "department": "Engineering",
      "role": "Senior Developer"
    }
  }'
```

**Response**:
```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "projectId": "660e8400-e29b-41d4-a716-446655440000",
    "externalId": "user_12345",
    "name": "Alice Johnson",
    "email": "alice@example.com",
    "avatarUrl": "https://example.com/avatars/alice.jpg",
    "metadata": {
      "department": "Engineering",
      "role": "Senior Developer"
    },
    "isOnline": false,
    "createdAt": "2026-10-21T10:00:00.000Z",
    "updatedAt": "2026-10-21T10:00:00.000Z"
  }
}
```

### List Users

**Endpoint**: `GET /api/v1/users`

```bash
# List all users
curl http://localhost:3000/api/v1/users \
  -H "Authorization: Bearer <token>"

# Search users
curl http://localhost:3000/api/v1/users?search=alice \
  -H "Authorization: Bearer <token>"

# Find by external ID
curl http://localhost:3000/api/v1/users?externalId=user_12345 \
  -H "Authorization: Bearer <token>"

# Pagination
curl "http://localhost:3000/api/v1/users?limit=20&offset=0" \
  -H "Authorization: Bearer <token>"
```

---

## Conversations

### Create a Direct Conversation

**Endpoint**: `POST /api/v1/conversations`

```bash
curl -X POST http://localhost:3000/api/v1/conversations \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "direct",
    "title": "Alice and Bob",
    "participantIds": [
      "550e8400-e29b-41d4-a716-446655440000",
      "660e8400-e29b-41d4-a716-446655440001"
    ]
  }'
```

### Create a Group Conversation

```bash
curl -X POST http://localhost:3000/api/v1/conversations \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "group",
    "title": "Engineering Team",
    "participantIds": [
      "550e8400-e29b-41d4-a716-446655440000",
      "660e8400-e29b-41d4-a716-446655440001",
      "770e8400-e29b-41d4-a716-446655440002"
    ],
    "metadata": {
      "department": "engineering",
      "project": "messaging-api"
    }
  }'
```

### Create a Support Conversation

```bash
curl -X POST http://localhost:3000/api/v1/conversations \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "support",
    "title": "Customer Support #1234",
    "participantIds": [
      "550e8400-e29b-41d4-a716-446655440000",
      "agent-uuid"
    ],
    "metadata": {
      "ticketId": "1234",
      "priority": "high"
    }
  }'
```

### List Conversations

```bash
# All conversations
curl http://localhost:3000/api/v1/conversations \
  -H "Authorization: Bearer <token>"

# Filter by type
curl http://localhost:3000/api/v1/conversations?type=group \
  -H "Authorization: Bearer <token>"

# Filter by user
curl "http://localhost:3000/api/v1/conversations?userId=<user-id>" \
  -H "Authorization: Bearer <token>"

# Archived conversations
curl http://localhost:3000/api/v1/conversations?isArchived=true \
  -H "Authorization: Bearer <token>"
```

**Response**:
```json
{
  "data": [
    {
      "id": "conv-uuid",
      "projectId": "project-uuid",
      "type": "group",
      "title": "Engineering Team",
      "participants": [
        {
          "id": "user-uuid",
          "name": "Alice Johnson",
          "email": "alice@example.com",
          "avatarUrl": "...",
          "role": "member"
        }
      ],
      "participantCount": 3,
      "messageCount": 42,
      "isArchived": false,
      "lastMessageAt": "2026-10-21T15:30:00.000Z",
      "createdAt": "2026-10-21T10:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 15,
    "totalPages": 1
  }
}
```

---

## Conversation Participants

### Add a Participant

**Endpoint**: `POST /api/v1/conversations/:id/participants`

Caller: a participant of the conversation, or an `admin`/`api` token. Idempotent.

```bash
curl -X POST http://localhost:3000/api/v1/conversations/<conversation-id>/participants \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "userId": "<user-id>" }'
```

**Response** (`201` when added, `200` when already a participant):
```json
{ "data": { "conversationId": "conv-uuid", "userId": "user-uuid" } }
```

In an end-to-end encrypted conversation the user must already have a registered device (`409 PARTICIPANT_HAS_NO_DEVICE`).

### Remove a Participant

**Endpoint**: `DELETE /api/v1/conversations/:id/participants/:userId`

Same authorization; a user may remove themselves. `404` when the user is not a participant.

```bash
curl -X DELETE http://localhost:3000/api/v1/conversations/<conversation-id>/participants/<user-id> \
  -H "Authorization: Bearer <token>"
```

**Response**:
```json
{ "data": { "conversationId": "conv-uuid", "userId": "user-uuid", "minKeyVersion": null } }
```
`minKeyVersion` is `null` for an ordinary conversation. For an end-to-end encrypted one it is the lowest key version that
may still be used; messages under older versions get `409 KEY_ROTATION_REQUIRED`.

---

## Messages

### Send a Text Message

**Endpoint**: `POST /api/v1/messages`

```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "conv-uuid",
    "senderId": "user-uuid",
    "content": "Hello everyone! 👋",
    "type": "text"
  }'
```

### Send a Message with Image

```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "conv-uuid",
    "senderId": "user-uuid",
    "content": "Check out this screenshot!",
    "type": "image",
    "attachments": [
      {
        "type": "image",
        "url": "https://cdn.example.com/images/screenshot.jpg",
        "thumbnailUrl": "https://cdn.example.com/images/screenshot_thumb.jpg",
        "filename": "screenshot.jpg",
        "mimeType": "image/jpeg",
        "sizeBytes": 204800,
        "width": 1920,
        "height": 1080
      }
    ]
  }'
```

### Send a Message with Video

```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "conv-uuid",
    "senderId": "user-uuid",
    "content": "Demo video",
    "type": "video",
    "attachments": [
      {
        "type": "video",
        "url": "https://cdn.example.com/videos/demo.mp4",
        "thumbnailUrl": "https://cdn.example.com/videos/demo_thumb.jpg",
        "filename": "demo.mp4",
        "mimeType": "video/mp4",
        "sizeBytes": 5242880,
        "width": 1280,
        "height": 720,
        "durationSeconds": 120
      }
    ]
  }'
```

### Send a Message with File

```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "conv-uuid",
    "senderId": "user-uuid",
    "content": "Here are the documents",
    "type": "file",
    "attachments": [
      {
        "type": "file",
        "url": "https://cdn.example.com/files/report.pdf",
        "filename": "Q4_Report_2026.pdf",
        "mimeType": "application/pdf",
        "sizeBytes": 1048576
      }
    ]
  }'
```

### Reply to a Message (Threading)

```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "conv-uuid",
    "senderId": "user-uuid",
    "parentId": "parent-message-uuid",
    "content": "Great point! I agree.",
    "type": "text"
  }'
```

### Fetch Messages

```bash
# Get all messages in a conversation
curl "http://localhost:3000/api/v1/messages?conversationId=<conv-uuid>" \
  -H "Authorization: Bearer <token>"

# Get messages with pagination
curl "http://localhost:3000/api/v1/messages?conversationId=<conv-uuid>&limit=20&offset=0" \
  -H "Authorization: Bearer <token>"

# Get messages before a specific time
curl "http://localhost:3000/api/v1/messages?conversationId=<conv-uuid>&before=2026-10-21T10:00:00Z" \
  -H "Authorization: Bearer <token>"

# Get messages after a specific time
curl "http://localhost:3000/api/v1/messages?conversationId=<conv-uuid>&after=2026-10-21T10:00:00Z" \
  -H "Authorization: Bearer <token>"

# Filter by message type
curl "http://localhost:3000/api/v1/messages?conversationId=<conv-uuid>&type=image" \
  -H "Authorization: Bearer <token>"

# Filter by sender
curl "http://localhost:3000/api/v1/messages?conversationId=<conv-uuid>&senderId=<user-uuid>" \
  -H "Authorization: Bearer <token>"
```

**Response**:
```json
{
  "data": [
    {
      "id": "msg-uuid",
      "conversationId": "conv-uuid",
      "sender": {
        "id": "user-uuid",
        "name": "Alice Johnson",
        "email": "alice@example.com",
        "avatarUrl": "..."
      },
      "content": "Hello everyone! 👋",
      "type": "text",
      "attachments": [],
      "reactionCount": 3,
      "isEdited": false,
      "isDeleted": false,
      "createdAt": "2026-10-21T15:30:00.000Z",
      "updatedAt": "2026-10-21T15:30:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 50
  }
}
```

---

## Reactions

### Add a Reaction

**Endpoint**: `POST /api/v1/reactions` (to be implemented)

```bash
curl -X POST http://localhost:3000/api/v1/reactions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "messageId": "msg-uuid",
    "emoji": "👍"
  }'
```

### Remove a Reaction

**Endpoint**: `DELETE /api/v1/reactions` (to be implemented)

```bash
curl -X DELETE http://localhost:3000/api/v1/reactions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "messageId": "msg-uuid",
    "emoji": "👍"
  }'
```

---

## Media Upload

### Upload an Image

Upload the file, then attach the returned URL to a message:

```bash
# 1. Upload (multipart). The response is { "data": [ { "url": "...", ... } ] }
curl -X POST http://localhost:3000/api/v1/uploads \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@image.jpg;type=image/jpeg"

# 2. Send a message that references it (the URL must be absolute)
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "conversationId": "<conversation-id>",
    "senderId": "<user-id>",
    "type": "image",
    "attachments": [{ "type": "image", "url": "<url from step 1>", "mimeType": "image/jpeg", "filename": "image.jpg" }]
  }'
```

For direct-to-storage uploads use `POST /api/v1/uploads/presign` (returns `501` on providers that cannot presign).
With the SDK ([`@messaging-express/client`](./packages/client/README.md)) the same thing is one call, with presign-then-fallback,
parallelism and per-file results handled for you:

```ts
import { createClient } from '@messaging-express/client';

const client = createClient({ baseUrl: 'https://api.example.com', token: () => getJwt() });
const outcomes = await client.uploads.upload(files, { category: 'messages' });
const attachments = outcomes.flatMap((o) => (o.ok ? [o.attachment] : []));
```

---

## Error Handling

### Validation Error (400)

```json
{
  "error": {
    "message": "Validation failed",
    "code": "VALIDATION_ERROR",
    "details": {
      "field": "email",
      "message": "Invalid email format"
    }
  }
}
```

### Unauthorized (401)

```json
{
  "error": {
    "message": "Invalid or expired token",
    "code": "UNAUTHORIZED"
  }
}
```

### Forbidden (403)

```json
{
  "error": {
    "message": "Sender is not a participant in this conversation",
    "code": "FORBIDDEN"
  }
}
```

### Not Found (404)

```json
{
  "error": {
    "message": "Conversation not found",
    "code": "NOT_FOUND"
  }
}
```

### Server Error (500)

Any unexpected failure. The message is always generic; the cause is only in the server logs.

```json
{
  "error": {
    "message": "Internal server error",
    "code": "INTERNAL_ERROR"
  }
}
```

### Rate Limit (429)

```json
{
  "error": {
    "message": "Too many requests",
    "code": "RATE_LIMIT_EXCEEDED"
  }
}
```

**Response Headers**:
```
Retry-After: 60
```

---

## Complete Example: Send a Message with Media

```javascript
// 1. Create users
const alice = await createUser({
  externalId: 'alice_123',
  name: 'Alice Johnson',
  email: 'alice@example.com'
});

const bob = await createUser({
  externalId: 'bob_456',
  name: 'Bob Smith',
  email: 'bob@example.com'
});

// 2. Create conversation
const conversation = await createConversation({
  type: 'direct',
  title: 'Alice and Bob',
  participantIds: [alice.id, bob.id]
});

// 3. Upload media
const imageFile = new File([blob], 'photo.jpg');
const uploadResult = await uploadFile(imageFile, 'msg-media', 'messages', 'image');

// 4. Send message with attachment
const message = await sendMessage({
  conversationId: conversation.id,
  senderId: alice.id,
  content: 'Check this out!',
  type: 'image',
  attachments: [{
    type: 'image',
    url: uploadResult.url,
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: imageFile.size
  }]
});

console.log('Message sent:', message.id);
```

---

## End-to-End Encryption

Needs `E2EE_ENABLED=on`. The server never sees plaintext or private keys: everything below carries public keys, opaque wrapped keys or ciphertext.
In practice you use the `@messaging-express/client-crypto` package, which makes these calls for you; the examples show what travels on the wire.
Binary values are base64url without padding. Routes that act on a device need the `X-Device-Id` header (it identifies the device; the JWT still authenticates).

### Register the first device
```bash
curl -X POST http://localhost:3000/api/v1/devices \
  -H "Authorization: Bearer <user-token>" -H "Content-Type: application/json" \
  -d '{ "publicKey": "<32-byte X25519 public key>", "deviceName": "Phone" }'
# 201 { "data": { "id": "device-uuid", "isPrimary": true, "createdAt": "..." } }
```
A user who already has a device gets `409 DEVICE_EXISTS`: add further devices with pairing (below).

### Add a device (key-bound pairing)
The new device shows its public key (QR code). The existing primary device approves exactly that key, then the new device claims it:
```bash
# on the primary device
curl -X POST http://localhost:3000/api/v1/devices/pair \
  -H "Authorization: Bearer <user-token>" -H "X-Device-Id: <primary-device-id>" -H "Content-Type: application/json" \
  -d '{ "publicKey": "<the new device public key>" }'
# on the new device (poll until it succeeds)
curl -X POST http://localhost:3000/api/v1/devices/link \
  -H "Authorization: Bearer <user-token>" -H "Content-Type: application/json" \
  -d '{ "publicKey": "<the new device public key>" }'
# 201 { "data": { "id", "isPrimary": false, "devices": [...], "conversationIds": [...] } }
```

### Create an encrypted conversation
`keys` must hold the conversation key wrapped for **exactly** the active devices of all participants (the creator is one of them).
```bash
curl -X POST http://localhost:3000/api/v1/conversations \
  -H "Authorization: Bearer <user-token>" -H "X-Device-Id: <device-id>" -H "Content-Type: application/json" \
  -d '{ "type": "direct", "participantIds": ["<me>", "<them>"], "encryptionMode": "e2ee-v1",
        "keys": [ { "deviceId": "<my-device>", "wrappedKey": "<73 bytes>", "wrappedByDeviceId": "<my-device>" },
                  { "deviceId": "<their-device>", "wrappedKey": "<73 bytes>", "wrappedByDeviceId": "<my-device>" } ] }'
```
If the device set changed: `409 STALE_DEVICE_SET` with `error.details.deviceIds` (the current set); re-wrap and retry.
A participant with no device: `409 PARTICIPANT_HAS_NO_DEVICE` with `error.details.userIds`.

### Fetch and upload conversation keys
```bash
curl http://localhost:3000/api/v1/conversations/<id>/keys -H "Authorization: Bearer <user-token>" -H "X-Device-Id: <device-id>"
curl -X POST http://localhost:3000/api/v1/conversations/<id>/keys \
  -H "Authorization: Bearer <user-token>" -H "X-Device-Id: <device-id>" -H "Content-Type: application/json" \
  -d '{ "keyVersion": 2, "keys": [ { "deviceId": "...", "wrappedKey": "...", "wrappedByDeviceId": "<my-device>" } ] }'
```
A new version (latest + 1) must cover exactly the active devices of the current participants. Wraps for an existing version may be added for devices of current participants (a new device, a new member). `409 KEY_EXISTS` means someone else already uploaded it: fetch theirs instead.
Ask for a key you lack: `POST /api/v1/conversations/<id>/keys/request`.

### Send an encrypted message
```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer <user-token>" -H "Content-Type: application/json" \
  -d '{ "conversationId": "<id>", "senderId": "<me>", "content": "<base64url ciphertext>",
        "metadata": { "scheme": "ck-xchacha-v1", "key_version": 1 } }'
```
Plaintext is refused with `400`; a `key_version` below the conversation's `min_key_version` with `409 KEY_ROTATION_REQUIRED` (`error.details.minKeyVersion`); a conversation with no uploaded key with `409 KEYS_NOT_READY`.
Attachments on an encrypted message must be opaque blobs (`application/octet-stream`), uploaded with `category=e2ee`:
```bash
curl -X POST http://localhost:3000/api/v1/uploads -H "Authorization: Bearer <user-token>" \
  -F "category=e2ee" -F "file=@encrypted.bin;type=application/octet-stream"
```

### Key backup
```bash
curl -X PUT http://localhost:3000/api/v1/devices/backup -H "Authorization: Bearer <user-token>" -H "Content-Type: application/json" \
  -d '{ "blob": "<base64url, at most 8192 bytes>", "kdf": { "v": 1, "alg": "argon2id", "m": 19456, "t": 2, "p": 1, "salt": "<16-64 bytes>" } }'
curl http://localhost:3000/api/v1/devices/backup -H "Authorization: Bearer <user-token>"      # 404 when none
curl -X DELETE http://localhost:3000/api/v1/devices/backup -H "Authorization: Bearer <user-token>"
```
The blob is encrypted on the device with a key derived from the user's passphrase; the server cannot read it.

### Revoke devices
```bash
curl -X DELETE http://localhost:3000/api/v1/devices/<device-id> -H "Authorization: Bearer <user-token>" -H "X-Device-Id: <device-id>"
# admin or API token only: revoke ALL of a user's devices (recovery)
curl -X POST http://localhost:3000/api/v1/users/<user-id>/devices/reset -H "Authorization: Bearer <admin-or-api-token>"
```

Realtime: with `E2EE_ENABLED=on` a socket with a user token joins the room `user:<userId>` automatically and receives `device.added`, `device.removed`, `keys.updated`, `keys.requested`, `participant.added`, `participant.removed`. `device.added` and `device.removed` are also sent to webhooks. See `docs/E2EE_API_CONTRACT.md`.

---

## Need Help?

- 📖 [Full Documentation](./README.md)
- 🏗️ [Architecture Guide](./ARCHITECTURE.md)
- 🚀 [Setup Guide](./SETUP_GUIDE.md)
- 💬 [GitHub Issues](your-repo/issues)
