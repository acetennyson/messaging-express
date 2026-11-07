# Concepts

The handful of ideas that make the rest of the documentation easy to follow.

## The tenancy model

```
Organization ("Acme")                 the customer: owns webhook settings
 └─ Project ("Acme Chat")             one app: the unit that isolates data
     ├─ Users                         the people in your app
     ├─ Conversations                 who is talking
     │   ├─ Participants              which users are in it
     │   └─ Messages                  what was said (+ attachments)
     └─ Devices, keys, backups        only used for end-to-end encryption
```

- **Everything belongs to one project.** A token is signed for one `projectId`, and every query is filtered by it. A token for project A can never see project B's data, even in the same database.
- **Organizations and projects are rows you create** (see [Getting started](getting-started.md#5-create-an-organization-and-a-project)). One server can host many projects, which is what makes it usable as a service for several customers.
- Deactivating a project (`is_active = false`) or its organization immediately makes every token for it fail with `401`. If you enable `PROJECT_CACHE_TTL_SECONDS`, each server instance keeps working for up to that many seconds first.

## Users: yours, mirrored

Messaging Express does not do accounts or login. A **user** here is a record that mirrors a person in *your* system:

- `externalId` is your id for them (your database primary key, an auth provider id, anything up to 255 characters).
- `POST /users` with an `externalId` that already exists **replaces** that user's fields (name, email, avatar, metadata). Fields you leave out are reset (email becomes `null`, metadata becomes `{}`), so always send the full record.
- `POST /users` without an `externalId` always creates a new row. Use `externalId` unless you really want that.
- The `id` (a UUID) is Messaging Express's id. Conversations, messages and tokens use it. Store it next to your own id, or look it up with `GET /users?externalId=...`.

## Conversations and participants

A conversation has a `type` of `direct`, `group` or `support`, an optional title, free-form `metadata`, and a list of participants.

- The type is a label for your UI. The server does not limit a `direct` conversation to two people or stop you adding people to it.
- Creating a conversation needs at least one participant, and every participant must be a user of the same project. Duplicate ids are rejected.
- Any participant (or your backend) can add or remove participants later. A user can remove themselves.
- Each new message bumps the conversation's `last_message_at` (the list is sorted by it, newest first) and raises the `unread_count` of the other participants.

## Messages

- A message belongs to a conversation and a sender, who must be a participant.
- `type` is `text` (default), `image`, `video`, `file` or `system`. It is a label for your UI; attachments are separate records on the message.
- `content` is optional (a message can be only attachments).
- `parentId` makes a message a reply. The API stores it and returns it; building the thread view is up to your client.
- Messages are listed **newest first**.
- The API returns each message with its `sender` (name, email, avatar) and its `attachments`.

## Three kinds of token

Every request carries a JWT that your backend signed. The claim `type` says who is calling:

| `type` | Who it is for | Can do |
|---|---|---|
| `user` | One end user, in their own app. Needs a `userId` claim. | Whatever [access control](access-control.md) allows: their own conversations, sending as themselves. |
| `api` | Your backend | Everything in the project, for any user. |
| `admin` | Your backend, admin operations | Same as `api`, and is also accepted where an admin is required (for example resetting a user's encryption devices). |

The golden rule: **user tokens go to client apps, api and admin tokens never leave your servers.** Details and code: [Authentication](authentication.md).

## What is and is not enforced for user tokens

By default a user token is limited only to its own project, which is the behaviour the API has always had. Restricting a user token to its own conversations is a switch you turn on deliberately ([Access control](access-control.md)), except for encrypted conversations, where it is always on. Read that page before putting real users on the API.

## Realtime and webhooks

Two ways to hear about things that happen:

- **Realtime (Socket.IO)** is for your end users' apps. A client joins a conversation and receives `message.created` and the encryption events live. See [Realtime](realtime.md).
- **Webhooks** are for your backend. The server POSTs a signed JSON body to the URL stored on the organization for `user.created`, `conversation.created`, `message.created` and more. See [Webhooks](webhooks.md).

## End-to-end encryption (optional)

A conversation can be created with `encryptionMode: "e2ee-v1"`. Then message text and attachment contents are encrypted on the users' devices and the server only ever stores ciphertext. It needs the extra `@messaging-express/client-crypto` package on the client, and it changes some rules (for example the sender must send encrypted content, and membership changes force a key rotation). Start with [What E2EE protects](e2ee/overview.md).

## Response conventions

- Successful responses are `{ "data": ... }`, lists add `"meta"` with paging info.
- Errors are `{ "error": { "message": "...", "code": "..." } }` with an HTTP status that matches. Some errors add `details`.
- Field names are the database's: `snake_case` (`conversation_id`, `created_at`). The objects the API builds itself, such as `sender` and `participants`, use `camelCase` (`avatarUrl`). The JavaScript client types document this exactly.
- Counts such as `participant_count` and `message_count` come back as **strings** (a Postgres quirk). Convert them with `Number(...)`.
- Timestamps are ISO 8601 in UTC.
- IDs are UUIDs.
