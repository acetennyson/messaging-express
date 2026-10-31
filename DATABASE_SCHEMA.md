> **Table names:** this database is shared with another project, so every table below is created as `mx_<name>` (for example `users` is `mx_users`) and indexes are `idx_mx_<name>`. See `scripts/migrate.ts`. For a database migrated before the prefix existed, run `scripts/rename-to-mx-prefix.sql` once.

# Messaging Express - Database Schema

## Core Tables

### 1. Organizations (Multi-tenancy)
```sql
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  plan VARCHAR(50) DEFAULT 'free', -- free, pro, enterprise
  api_key VARCHAR(64) UNIQUE NOT NULL,
  api_secret_hash VARCHAR(255) NOT NULL,
  webhook_url TEXT,
  webhook_secret VARCHAR(64),
  rate_limit_override INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_organizations_slug ON organizations(slug);
CREATE INDEX idx_organizations_api_key ON organizations(api_key);
```

### 2. Projects (Each org can have multiple projects)
```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  api_key VARCHAR(64) UNIQUE NOT NULL,
  allowed_origins TEXT[], -- CORS whitelist
  settings JSONB DEFAULT '{}', -- customization settings
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_projects_org_id ON projects(organization_id);
CREATE INDEX idx_projects_api_key ON projects(api_key);
```

### 3. Users (End users of your clients' apps)
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_id VARCHAR(255), -- client's user ID
  name VARCHAR(255),
  email VARCHAR(255),
  avatar_url TEXT,
  metadata JSONB DEFAULT '{}',
  is_online BOOLEAN DEFAULT false,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, external_id)
);

CREATE INDEX idx_users_project_id ON users(project_id);
CREATE INDEX idx_users_external_id ON users(project_id, external_id);
CREATE INDEX idx_users_email ON users(email);
```

### 4. Conversations
```sql
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, -- direct, group, support
  title VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  is_archived BOOLEAN DEFAULT false,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_conversations_project_id ON conversations(project_id);
CREATE INDEX idx_conversations_type ON conversations(type);
CREATE INDEX idx_conversations_last_message ON conversations(last_message_at DESC);
```

### 5. Conversation Participants
```sql
CREATE TABLE conversation_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) DEFAULT 'member', -- admin, member, agent, customer
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  last_read_at TIMESTAMPTZ,
  unread_count INTEGER DEFAULT 0,
  is_muted BOOLEAN DEFAULT false,
  UNIQUE(conversation_id, user_id)
);

CREATE INDEX idx_participants_conversation ON conversation_participants(conversation_id);
CREATE INDEX idx_participants_user ON conversation_participants(user_id);
```

### 6. Messages (Core messaging table)
```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  parent_id UUID REFERENCES messages(id), -- for threading/replies
  content TEXT,
  type VARCHAR(50) DEFAULT 'text', -- text, image, video, file, system
  metadata JSONB DEFAULT '{}',
  is_edited BOOLEAN DEFAULT false,
  edited_at TIMESTAMPTZ,
  is_deleted BOOLEAN DEFAULT false,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at DESC);
CREATE INDEX idx_messages_sender ON messages(sender_id);
CREATE INDEX idx_messages_parent ON messages(parent_id);
CREATE INDEX idx_messages_type ON messages(type);
```

### 7. Message Attachments
```sql
CREATE TABLE message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, -- image, video, file
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  filename VARCHAR(255),
  mime_type VARCHAR(100),
  size_bytes BIGINT,
  width INTEGER,
  height INTEGER,
  duration_seconds INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_attachments_message ON message_attachments(message_id);
CREATE INDEX idx_attachments_type ON message_attachments(type);
```

### 8. Message Reactions
```sql
CREATE TABLE message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);

CREATE INDEX idx_reactions_message ON message_reactions(message_id);
```

### 9. Typing Indicators (In-memory/Redis preferred, but can use Postgres)
```sql
CREATE TABLE typing_indicators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE(conversation_id, user_id)
);

CREATE INDEX idx_typing_conversation ON typing_indicators(conversation_id);
CREATE INDEX idx_typing_expires ON typing_indicators(expires_at);
```

### 10. Webhooks Log
```sql
CREATE TABLE webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  url TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  attempts INTEGER DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_webhook_logs_project ON webhook_logs(project_id);
CREATE INDEX idx_webhook_logs_event ON webhook_logs(event_type);
CREATE INDEX idx_webhook_logs_retry ON webhook_logs(next_retry_at) WHERE completed_at IS NULL;
```

### 11. Rate Limits
```sql
CREATE TABLE rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(255) UNIQUE NOT NULL,
  count INTEGER DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_rate_limits_key ON rate_limits(key);
CREATE INDEX idx_rate_limits_expires ON rate_limits(expires_at);
```

### 12. API Keys & Tokens
```sql
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  key_hash VARCHAR(255) NOT NULL,
  key_prefix VARCHAR(20) NOT NULL, -- for display (e.g., "mex_live_abc...")
  permissions TEXT[] DEFAULT ARRAY['messages:read', 'messages:write'],
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_keys_project ON api_keys(project_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
```

### 13. Analytics Events
```sql
CREATE TABLE analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_analytics_project ON analytics_events(project_id, created_at DESC);
CREATE INDEX idx_analytics_type ON analytics_events(event_type);
```

### 14. End-to-end encryption (Stage 7.1; unused until `E2EE_ENABLED=on`)

`mx_conversations` gains `encryption_mode TEXT NOT NULL DEFAULT 'none'` (`none` | `e2ee-v1` | `e2ee-v2`, CHECK) and
`min_key_version INTEGER NOT NULL DEFAULT 1`. The server stores only public keys and opaque ciphertext/wrapped keys.

| Table | Purpose |
|---|---|
| `mx_devices` | One row per device: `public_key` (X25519, base64url), `is_primary`, `revoked_at`. Unique: one active primary per user; one active row per (user, key). |
| `mx_conversation_keys` | PK `(conversation_id, device_id, key_version)`: the conversation key wrapped for that device, plus `wrapped_by_device_id` (NULL only if the wrapper's row was hard-deleted). |
| `mx_pairing_requests` | PK `(user_id, public_key)`: a primary's approval of one specific new-device key, with `expires_at` / `consumed_at`. Nothing secret. |
| `mx_key_backups` | One row per user: passphrase-encrypted device key `blob` + `kdf` parameters (JSONB). The API limits the decoded blob to 8192 bytes and the kdf to `{ v: 1, alg: "argon2id", m, t, p, salt }`. |

Notes:
- Removing a participant (route, Stage 7.7) sets `min_key_version = GREATEST(min_key_version, MAX(key_version) + 1)` for an `e2ee-v1` conversation in the same transaction.
- Key upload, participant add and participant remove all take `SELECT ... FOR UPDATE` on the conversation row; device changes take `FOR UPDATE` on the user row (key upload reads it `FOR SHARE`).
- `mx_messages.sender_id` is `NOT NULL` but its foreign key is `ON DELETE SET NULL`: deleting a user who has sent messages fails until those messages are deleted. (Matters for cleanup scripts and tests.)

## Cleanup & Maintenance

### Delete old typing indicators
```sql
DELETE FROM typing_indicators WHERE expires_at < NOW();
```

### Cleanup old webhook logs (retention policy)
```sql
DELETE FROM webhook_logs WHERE created_at < NOW() - INTERVAL '30 days';
```

### Cleanup expired rate limits
```sql
DELETE FROM rate_limits WHERE expires_at < NOW();
```

## Indexes for Performance
All indexes are already included in the table definitions above for optimal query performance.
