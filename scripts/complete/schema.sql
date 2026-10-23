-- =====================================================================
-- Messaging Express: full database schema (13 tables, all prefixed mx_).
--
-- RESET: drops every Messaging Express table so this file can be pasted into the
-- Supabase SQL editor (or run with psql) and rebuild the schema from scratch.
-- THIS DELETES ALL MESSAGING EXPRESS DATA.
--
-- It only touches mx_* objects, so it is safe in a database shared with another
-- project (their users, tasks, rate_limits, ... are never dropped or altered).
--
-- Source of truth is scripts/migrate.ts (which adds tables without dropping
-- anything). This file is that same schema plus the reset. If you change one,
-- change the other.
-- =====================================================================
DROP TABLE IF EXISTS mx_analytics_events;
DROP TABLE IF EXISTS mx_api_keys;
DROP TABLE IF EXISTS mx_rate_limits;
DROP TABLE IF EXISTS mx_webhook_logs;
DROP TABLE IF EXISTS mx_typing_indicators;
DROP TABLE IF EXISTS mx_message_reactions;
DROP TABLE IF EXISTS mx_message_attachments;
DROP TABLE IF EXISTS mx_messages;
DROP TABLE IF EXISTS mx_conversation_participants;
DROP TABLE IF EXISTS mx_conversations;
DROP TABLE IF EXISTS mx_users;
DROP TABLE IF EXISTS mx_projects;
DROP TABLE IF EXISTS mx_organizations;

-- create_organizations
CREATE TABLE IF NOT EXISTS mx_organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  plan VARCHAR(50) DEFAULT 'free',
  api_key VARCHAR(64) UNIQUE NOT NULL,
  api_secret_hash VARCHAR(255) NOT NULL,
  webhook_url TEXT,
  webhook_secret VARCHAR(64),
  rate_limit_override INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mx_organizations_slug ON mx_organizations(slug);
CREATE INDEX IF NOT EXISTS idx_mx_organizations_api_key ON mx_organizations(api_key);

-- create_projects
CREATE TABLE IF NOT EXISTS mx_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES mx_organizations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  api_key VARCHAR(64) UNIQUE NOT NULL,
  allowed_origins TEXT[],
  settings JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mx_projects_org_id ON mx_projects(organization_id);
CREATE INDEX IF NOT EXISTS idx_mx_projects_api_key ON mx_projects(api_key);

-- create_users
CREATE TABLE IF NOT EXISTS mx_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES mx_projects(id) ON DELETE CASCADE,
  external_id VARCHAR(255),
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

CREATE INDEX IF NOT EXISTS idx_mx_users_project_id ON mx_users(project_id);
CREATE INDEX IF NOT EXISTS idx_mx_users_external_id ON mx_users(project_id, external_id);
CREATE INDEX IF NOT EXISTS idx_mx_users_email ON mx_users(email);

-- create_conversations
CREATE TABLE IF NOT EXISTS mx_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES mx_projects(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  is_archived BOOLEAN DEFAULT false,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mx_conversations_project_id ON mx_conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_mx_conversations_type ON mx_conversations(type);
CREATE INDEX IF NOT EXISTS idx_mx_conversations_last_message ON mx_conversations(last_message_at DESC NULLS LAST);

-- create_conversation_participants
CREATE TABLE IF NOT EXISTS mx_conversation_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES mx_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES mx_users(id) ON DELETE CASCADE,
  role VARCHAR(50) DEFAULT 'member',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  last_read_at TIMESTAMPTZ,
  unread_count INTEGER DEFAULT 0,
  is_muted BOOLEAN DEFAULT false,
  UNIQUE(conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_mx_participants_conversation ON mx_conversation_participants(conversation_id);
CREATE INDEX IF NOT EXISTS idx_mx_participants_user ON mx_conversation_participants(user_id);

-- create_messages
CREATE TABLE IF NOT EXISTS mx_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES mx_conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES mx_users(id) ON DELETE SET NULL,
  parent_id UUID REFERENCES mx_messages(id),
  content TEXT,
  type VARCHAR(50) DEFAULT 'text',
  metadata JSONB DEFAULT '{}',
  is_edited BOOLEAN DEFAULT false,
  edited_at TIMESTAMPTZ,
  is_deleted BOOLEAN DEFAULT false,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mx_messages_conversation ON mx_messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mx_messages_sender ON mx_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_mx_messages_parent ON mx_messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_mx_messages_type ON mx_messages(type);

-- create_message_attachments
CREATE TABLE IF NOT EXISTS mx_message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES mx_messages(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_mx_attachments_message ON mx_message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_mx_attachments_type ON mx_message_attachments(type);

-- create_message_reactions
CREATE TABLE IF NOT EXISTS mx_message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES mx_messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES mx_users(id) ON DELETE CASCADE,
  emoji VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_mx_reactions_message ON mx_message_reactions(message_id);

-- create_typing_indicators
CREATE TABLE IF NOT EXISTS mx_typing_indicators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES mx_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES mx_users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE(conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_mx_typing_conversation ON mx_typing_indicators(conversation_id);
CREATE INDEX IF NOT EXISTS idx_mx_typing_expires ON mx_typing_indicators(expires_at);

-- create_webhook_logs
CREATE TABLE IF NOT EXISTS mx_webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES mx_projects(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_mx_webhook_logs_project ON mx_webhook_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_mx_webhook_logs_event ON mx_webhook_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_mx_webhook_logs_retry ON mx_webhook_logs(next_retry_at) WHERE completed_at IS NULL;

-- create_rate_limits
CREATE TABLE IF NOT EXISTS mx_rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(255) UNIQUE NOT NULL,
  count INTEGER DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mx_rate_limits_key ON mx_rate_limits(key);
CREATE INDEX IF NOT EXISTS idx_mx_rate_limits_expires ON mx_rate_limits(expires_at);

-- create_api_keys
CREATE TABLE IF NOT EXISTS mx_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES mx_projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  key_hash VARCHAR(255) NOT NULL,
  key_prefix VARCHAR(20) NOT NULL,
  permissions TEXT[] DEFAULT ARRAY['messages:read', 'messages:write'],
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mx_api_keys_project ON mx_api_keys(project_id);
CREATE INDEX IF NOT EXISTS idx_mx_api_keys_hash ON mx_api_keys(key_hash);

-- create_analytics_events
CREATE TABLE IF NOT EXISTS mx_analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES mx_projects(id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  user_id UUID REFERENCES mx_users(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES mx_conversations(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mx_analytics_project ON mx_analytics_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mx_analytics_type ON mx_analytics_events(event_type);

-- =====================================================================
-- DEMO SEED DATA
--
-- Adds one demo organization, project, api key, a handful of users,
-- conversations, messages, attachments, reactions and a couple of
-- supporting rows (webhook log, rate limit, analytics event).
--
-- Safe to re-run: it deletes any prior rows for the same demo
-- organization slug before inserting fresh ones.
-- =====================================================================

-- Clean up any previous run of this seed (only touches the demo org's data)
DELETE FROM mx_analytics_events WHERE project_id IN (
  SELECT p.id FROM mx_projects p JOIN mx_organizations o ON o.id = p.organization_id WHERE o.slug = 'demo-org'
);
DELETE FROM mx_api_keys WHERE project_id IN (
  SELECT p.id FROM mx_projects p JOIN mx_organizations o ON o.id = p.organization_id WHERE o.slug = 'demo-org'
);
DELETE FROM mx_rate_limits WHERE key LIKE 'rl:demo:%';
DELETE FROM mx_webhook_logs WHERE project_id IN (
  SELECT p.id FROM mx_projects p JOIN mx_organizations o ON o.id = p.organization_id WHERE o.slug = 'demo-org'
);
DELETE FROM mx_typing_indicators WHERE conversation_id IN (
  SELECT c.id FROM mx_conversations c JOIN mx_projects p ON p.id = c.project_id JOIN mx_organizations o ON o.id = p.organization_id WHERE o.slug = 'demo-org'
);
DELETE FROM mx_message_reactions WHERE message_id IN (
  SELECT m.id FROM mx_messages m JOIN mx_conversations c ON c.id = m.conversation_id JOIN mx_projects p ON p.id = c.project_id JOIN mx_organizations o ON o.id = p.organization_id WHERE o.slug = 'demo-org'
);
DELETE FROM mx_message_attachments WHERE message_id IN (
  SELECT m.id FROM mx_messages m JOIN mx_conversations c ON c.id = m.conversation_id JOIN mx_projects p ON p.id = c.project_id JOIN mx_organizations o ON o.id = p.organization_id WHERE o.slug = 'demo-org'
);
DELETE FROM mx_messages WHERE conversation_id IN (
  SELECT c.id FROM mx_conversations c JOIN mx_projects p ON p.id = c.project_id JOIN mx_organizations o ON o.id = p.organization_id WHERE o.slug = 'demo-org'
);
DELETE FROM mx_conversation_participants WHERE conversation_id IN (
  SELECT c.id FROM mx_conversations c JOIN mx_projects p ON p.id = c.project_id JOIN mx_organizations o ON o.id = p.organization_id WHERE o.slug = 'demo-org'
);
DELETE FROM mx_conversations WHERE project_id IN (
  SELECT p.id FROM mx_projects p JOIN mx_organizations o ON o.id = p.organization_id WHERE o.slug = 'demo-org'
);
DELETE FROM mx_users WHERE project_id IN (
  SELECT p.id FROM mx_projects p JOIN mx_organizations o ON o.id = p.organization_id WHERE o.slug = 'demo-org'
);
DELETE FROM mx_projects WHERE organization_id IN (
  SELECT id FROM mx_organizations WHERE slug = 'demo-org'
);
DELETE FROM mx_organizations WHERE slug = 'demo-org';

-- Organization + Project + API key
WITH org AS (
  INSERT INTO mx_organizations (name, slug, plan, api_key, api_secret_hash, webhook_url, webhook_secret, is_active)
  VALUES (
    'Demo Org',
    'demo-org',
    'pro',
    'org_demo_pk_1234567890abcdef',
    -- placeholder bcrypt-shaped hash; not a real secret
    '$2b$10$DEMOSEEDHASHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'https://webhook.site/demo-org-placeholder',
    'whsec_demo_1234567890',
    true
  )
  RETURNING id
),
proj AS (
  INSERT INTO mx_projects (organization_id, name, description, api_key, allowed_origins, settings, is_active)
  SELECT id, 'Demo Project', 'Seed project for local development and demos',
         'proj_demo_pk_abcdef1234567890',
         ARRAY['http://localhost:3000', 'https://demo.messaging-express.dev'],
         '{"storage": {"provider": "local"}}'::jsonb,
         true
  FROM org
  RETURNING id, organization_id
)
INSERT INTO mx_api_keys (project_id, name, key_hash, key_prefix, permissions, is_active)
SELECT id, 'Demo server key',
       '$2b$10$DEMOSEEDAPIKEYHASHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
       'mxk_demo',
       ARRAY['messages:read', 'messages:write', 'conversations:read', 'conversations:write'],
       true
FROM proj;

-- Users (4 demo users in the demo project)
INSERT INTO mx_users (project_id, external_id, name, email, avatar_url, metadata, is_online, last_seen_at)
SELECT p.id, u.external_id, u.name, u.email, u.avatar_url, u.metadata::jsonb, u.is_online, u.last_seen_at
FROM mx_projects p
JOIN mx_organizations o ON o.id = p.organization_id
CROSS JOIN (VALUES
  ('user_ada',    'Ada Lovelace',   'ada@demo.dev',    'https://i.pravatar.cc/150?u=ada',    '{"role": "admin"}', true,  NOW()),
  ('user_grace',  'Grace Hopper',   'grace@demo.dev',  'https://i.pravatar.cc/150?u=grace',  '{"role": "member"}', true,  NOW()),
  ('user_alan',   'Alan Turing',    'alan@demo.dev',   'https://i.pravatar.cc/150?u=alan',   '{"role": "member"}', false, NOW() - INTERVAL '2 hours'),
  ('user_margaret','Margaret Hamilton','margaret@demo.dev','https://i.pravatar.cc/150?u=margaret','{"role": "member"}', false, NOW() - INTERVAL '1 day')
) AS u(external_id, name, email, avatar_url, metadata, is_online, last_seen_at)
WHERE o.slug = 'demo-org';

-- Conversations: one direct (Ada/Grace), one group (all four)
WITH proj AS (
  SELECT p.id FROM mx_projects p JOIN mx_organizations o ON o.id = p.organization_id WHERE o.slug = 'demo-org'
),
direct_conv AS (
  INSERT INTO mx_conversations (project_id, type, title, metadata, last_message_at)
  SELECT id, 'direct', NULL, '{}'::jsonb, NOW() - INTERVAL '5 minutes' FROM proj
  RETURNING id
),
group_conv AS (
  INSERT INTO mx_conversations (project_id, type, title, metadata, last_message_at)
  SELECT id, 'group', 'Project Alpha Team', '{"icon": "rocket"}'::jsonb, NOW() - INTERVAL '1 minute' FROM proj
  RETURNING id
)
SELECT 1;

-- Participants
INSERT INTO mx_conversation_participants (conversation_id, user_id, role, last_read_at, unread_count)
SELECT c.id, u.id,
       CASE WHEN c.type = 'group' AND u.external_id = 'user_ada' THEN 'admin' ELSE 'member' END,
       CASE WHEN u.external_id = 'user_ada' THEN NOW() ELSE NOW() - INTERVAL '1 hour' END,
       CASE WHEN u.external_id = 'user_ada' THEN 0 ELSE 2 END
FROM mx_conversations c
JOIN mx_projects p ON p.id = c.project_id
JOIN mx_organizations o ON o.id = p.organization_id
JOIN mx_users u ON u.project_id = p.id
WHERE o.slug = 'demo-org'
  AND (
    (c.type = 'direct' AND u.external_id IN ('user_ada', 'user_grace'))
    OR (c.type = 'group' AND u.external_id IN ('user_ada', 'user_grace', 'user_alan', 'user_margaret'))
  );

-- Messages (direct conversation)
WITH ctx AS (
  SELECT c.id AS conversation_id, u.id AS user_id, u.external_id
  FROM mx_conversations c
  JOIN mx_projects p ON p.id = c.project_id
  JOIN mx_organizations o ON o.id = p.organization_id
  JOIN mx_users u ON u.project_id = p.id
  WHERE o.slug = 'demo-org' AND c.type = 'direct'
)
INSERT INTO mx_messages (conversation_id, sender_id, content, type, created_at)
SELECT
  (SELECT conversation_id FROM ctx LIMIT 1),
  (SELECT user_id FROM ctx WHERE external_id = m.sender_ext),
  m.content, m.type, NOW() - m.ago
FROM (VALUES
  ('user_ada',   'Hey Grace, got a minute to look at the uploads redesign?', 'text', INTERVAL '30 minutes'),
  ('user_grace', 'Sure, pulling it up now.', 'text', INTERVAL '28 minutes'),
  ('user_grace', 'The presign flow looks solid. One question about bucket limits.', 'text', INTERVAL '20 minutes'),
  ('user_ada',   'Shoot.', 'text', INTERVAL '19 minutes'),
  ('user_ada',   'Here''s the diagram', 'image', INTERVAL '6 minutes'),
  ('user_grace', 'Got it, makes sense now.', 'text', INTERVAL '5 minutes')
) AS m(sender_ext, content, type, ago);

-- Messages (group conversation)
WITH ctx AS (
  SELECT c.id AS conversation_id, u.id AS user_id, u.external_id
  FROM mx_conversations c
  JOIN mx_projects p ON p.id = c.project_id
  JOIN mx_organizations o ON o.id = p.organization_id
  JOIN mx_users u ON u.project_id = p.id
  WHERE o.slug = 'demo-org' AND c.type = 'group'
)
INSERT INTO mx_messages (conversation_id, sender_id, content, type, created_at)
SELECT
  (SELECT conversation_id FROM ctx LIMIT 1),
  (SELECT user_id FROM ctx WHERE external_id = m.sender_ext),
  m.content, m.type, NOW() - m.ago
FROM (VALUES
  ('user_margaret','Morning team — standup notes are in the doc.', 'text', INTERVAL '2 hours'),
  ('user_alan',    'Rate limiter is passing load tests, moving to dry-run next.', 'text', INTERVAL '90 minutes'),
  ('user_ada',     'Nice. Webhooks stage is unblocked too.', 'text', INTERVAL '80 minutes'),
  ('user_grace',   'I''ll pick up the realtime provider once Stage 4 lands.', 'text', INTERVAL '70 minutes'),
  ('user_alan',    'Sounds good 👍', 'text', INTERVAL '65 minutes'),
  ('user_margaret','Let''s sync at 3pm', 'text', INTERVAL '1 minute')
) AS m(sender_ext, content, type, ago);

-- Attachment (on the "Here's the diagram" message)
INSERT INTO mx_message_attachments (message_id, type, url, thumbnail_url, filename, mime_type, size_bytes, width, height)
SELECT m.id, 'image',
       'https://demo.messaging-express.dev/uploads/demo/architecture-diagram.png',
       'https://demo.messaging-express.dev/uploads/demo/architecture-diagram-thumb.png',
       'architecture-diagram.png', 'image/png', 482_933, 1600, 900
FROM mx_messages m
WHERE m.content = 'Here''s the diagram';

-- Reactions
INSERT INTO mx_message_reactions (message_id, user_id, emoji)
SELECT m.id, u.id, r.emoji
FROM mx_messages m
JOIN mx_conversations c ON c.id = m.conversation_id
JOIN mx_projects p ON p.id = c.project_id
JOIN mx_organizations o ON o.id = p.organization_id
JOIN mx_users u ON u.project_id = p.id
CROSS JOIN (VALUES ('👍')) AS r(emoji)
WHERE o.slug = 'demo-org'
  AND m.content = 'Sounds good 👍'
  AND u.external_id IN ('user_margaret', 'user_grace');

-- Typing indicator (demo: Alan is typing in the group chat right now)
INSERT INTO mx_typing_indicators (conversation_id, user_id, started_at, expires_at)
SELECT c.id, u.id, NOW(), NOW() + INTERVAL '10 seconds'
FROM mx_conversations c
JOIN mx_projects p ON p.id = c.project_id
JOIN mx_organizations o ON o.id = p.organization_id
JOIN mx_users u ON u.project_id = p.id
WHERE o.slug = 'demo-org' AND c.type = 'group' AND u.external_id = 'user_alan';

-- Webhook log (one successful delivery example)
INSERT INTO mx_webhook_logs (project_id, event_type, payload, url, response_status, response_body, attempts, completed_at)
SELECT p.id, 'message.created',
       '{"event": "message.created", "data": {"conversationId": "demo", "content": "Sounds good 👍"}}'::jsonb,
       'https://webhook.site/demo-org-placeholder', 200, '{"ok":true}', 1, NOW() - INTERVAL '1 minute'
FROM mx_projects p JOIN mx_organizations o ON o.id = p.organization_id
WHERE o.slug = 'demo-org';

-- Rate limit row (demo key, well under any limit)
INSERT INTO mx_rate_limits (key, count, window_start, expires_at)
VALUES ('rl:demo:messages:demo-project:user_ada', 3, NOW() - INTERVAL '10 seconds', NOW() + INTERVAL '50 seconds');

-- Analytics event
INSERT INTO mx_analytics_events (project_id, event_type, user_id, conversation_id, metadata)
SELECT p.id, 'conversation.opened', u.id, c.id, '{"source": "demo-seed"}'::jsonb
FROM mx_projects p
JOIN mx_organizations o ON o.id = p.organization_id
JOIN mx_users u ON u.project_id = p.id AND u.external_id = 'user_ada'
JOIN mx_conversations c ON c.project_id = p.id AND c.type = 'group'
WHERE o.slug = 'demo-org';

-- Done. Quick sanity check query (run manually if you like):
-- SELECT o.name, p.name, count(u.*) FROM mx_organizations o
--   JOIN mx_projects p ON p.organization_id = o.id
--   JOIN mx_users u ON u.project_id = p.id
--   WHERE o.slug = 'demo-org' GROUP BY o.name, p.name;
