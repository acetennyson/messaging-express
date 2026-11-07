# Database

Messaging Express uses one Postgres database (version 13+; 16 in the docker compose file). All tables are prefixed `mx_` so they can live beside your own tables in the same database. Create or update the schema with:

```bash
npx tsx --env-file=.env.local scripts/migrate.ts     # same as: npm run db:migrate (needs DATABASE_URL in the real environment)
```

The migration script is **safe to re-run**: every step is idempotent (`IF NOT EXISTS`), and new steps are only ever appended. Run it on every deploy, before starting the new version.

## Overview

```
mx_organizations 1──* mx_projects 1──* mx_users
                          │               │
                          │               ├──* mx_conversation_participants *──1 mx_conversations
                          │               │                                          │
                          │               └──* mx_devices (E2EE)                     └──* mx_messages 1──* mx_message_attachments
                          └──* mx_conversations
```

Everything hangs off a **project**, and every query filters by the project id in the caller's token. Two projects never see each other's rows. Deleting an organization or project cascades to everything under it.

## Tables in use

### `mx_organizations`
The customer account. Holds the webhook settings.

| Column | Notes |
|---|---|
| `id` | UUID |
| `name`, `slug` (unique), `plan` | `plan` defaults to `free`; informational |
| `webhook_url`, `webhook_secret` | Where [webhooks](webhooks.md) go and the HMAC key |
| `is_active` | `false` makes every token of every project in it fail with 401 |
| `api_key`, `api_secret_hash` | Required by the schema but **not used** by the API. Fill them with any unique string and any text (see seed below). |
| `rate_limit_override` | Not used yet |

### `mx_projects`
One app / environment. Tokens carry a project id.

| Column | Notes |
|---|---|
| `id`, `organization_id` | |
| `name`, `description` | |
| `is_active` | `false` makes its tokens fail with 401 |
| `api_key` | Required, unique, **not used** by the API |
| `allowed_origins`, `settings` | Not used yet (CORS is global, see [Configuration](configuration.md#cors)) |

### `mx_users`
The people in your app, as the chat system knows them.

`id`, `project_id`, `external_id` (your id; unique per project), `name`, `email`, `avatar_url`, `metadata` (JSONB), `is_online` and `last_seen_at` (not updated by the server today), timestamps.

### `mx_conversations`
`id`, `project_id`, `type` (`direct`, `group`, `support`), `title`, `metadata`, `is_archived`, `last_message_at` (updated on every message; drives list order), timestamps, and for encryption `encryption_mode` (`none`, `e2ee-v1`, `e2ee-v2`) and `min_key_version`.

### `mx_conversation_participants`
Membership. Unique on `(conversation_id, user_id)`.

`role` (`member`; free text), `joined_at`, `unread_count` (incremented for everyone except the sender on each message; nothing resets it yet), `last_read_at` and `is_muted` (not used yet).

### `mx_messages`
`id`, `conversation_id`, `sender_id`, `parent_id` (reply), `content`, `type`, `metadata`, `is_edited`, `edited_at`, `is_deleted`, `deleted_at`, timestamps. The edit and delete columns exist for future routes; no endpoint sets them.

Messages are listed newest first through the index on `(conversation_id, created_at)`.

### `mx_message_attachments`
`message_id`, `type` (`image`, `video`, `file`), `url`, `thumbnail_url`, `filename`, `mime_type`, `size_bytes`, `width`, `height`, `duration_seconds`, `metadata`. Only URLs are stored, never file bytes.

### `mx_webhook_logs`
One row per webhook event: `event_type`, `payload`, `url`, `response_status`, `response_body` (truncated to 1000 chars), `attempts`, `next_retry_at`, `created_at`, `completed_at`. Rows with `completed_at IS NULL` and a due `next_retry_at` are what the retry worker picks up. This table grows forever: archive or delete old rows (for example older than 30 days) in a scheduled job.

### `mx_rate_limits`
Counters for [rate limiting](rate-limiting.md): `key`, `count`, `window_start`, `expires_at`. Expired rows are removed opportunistically in the background while requests run.

## Encryption tables

Only used when `E2EE_ENABLED=on`. Safe to leave empty otherwise. Details in the [E2EE guide](e2ee/guide.md).

| Table | Purpose |
|---|---|
| `mx_devices` | One row per user device: `public_key`, `device_name`, `is_primary`, `revoked_at`. At most one active primary per user. |
| `mx_conversation_keys` | The conversation key, wrapped for each device and key version. Primary key `(conversation_id, device_id, key_version)`. The server cannot unwrap these. |
| `mx_pairing_requests` | A primary device's short-lived approval of one specific new device key. |
| `mx_key_backups` | A user's password-encrypted key backup blob and its KDF settings. |

## Tables that exist but are not used yet

`mx_message_reactions`, `mx_typing_indicators`, `mx_api_keys`, `mx_analytics_events`. Created for future features; no route reads or writes them. Ignore them.

## Seeding an organization and a project

There is no signup endpoint: you create these two rows yourself, once per tenant.

```sql
INSERT INTO mx_organizations (name, slug, api_key, api_secret_hash)
VALUES ('Acme', 'acme', 'org_' || md5(random()::text), 'unused')
RETURNING id;

INSERT INTO mx_projects (organization_id, name, api_key)
VALUES ('<organization id>', 'Acme Chat', 'proj_' || md5(random()::text))
RETURNING id;      -- this is the projectId you put in tokens
```

Then mint tokens for that project id ([Authentication](authentication.md)). To run a second app, add another project.

## Useful queries

```sql
-- Messages per project, last 24 hours
SELECT p.name, count(*) FROM mx_messages m
JOIN mx_conversations c ON c.id = m.conversation_id
JOIN mx_projects p ON p.id = c.project_id
WHERE m.created_at > now() - interval '1 day' GROUP BY p.name;

-- Failed webhooks waiting for a retry
SELECT event_type, attempts, next_retry_at, response_status FROM mx_webhook_logs
WHERE completed_at IS NULL ORDER BY next_retry_at;

-- Switch a tenant off (all its tokens stop working within PROJECT_CACHE_TTL_SECONDS)
UPDATE mx_projects SET is_active = false WHERE id = '<project id>';
```

## Backups and upgrades

- Back up with `pg_dump` like any Postgres database. The encryption tables are part of the dump; they contain only public keys, wrapped keys and encrypted blobs.
- New releases only add tables or columns, and the additive steps run without long locks. Take a backup, run the migration, then roll out the new version.
- Moving from the old unprefixed table names (`users`, `messages`, ...)? Run `scripts/rename-to-mx-prefix.sql` once. It refuses to touch tables that do not look like Messaging Express's.
