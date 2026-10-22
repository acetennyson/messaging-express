import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

const migrations = [
  {
    name: 'create_organizations',
    sql: `
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
    `,
  },
  {
    name: 'create_projects',
    sql: `
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
    `,
  },
  {
    name: 'create_users',
    sql: `
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
    `,
  },
  {
    name: 'create_conversations',
    sql: `
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
    `,
  },
  {
    name: 'create_conversation_participants',
    sql: `
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
    `,
  },
  {
    name: 'create_messages',
    sql: `
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
    `,
  },
  {
    name: 'create_message_attachments',
    sql: `
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
    `,
  },
  {
    name: 'create_message_reactions',
    sql: `
      CREATE TABLE IF NOT EXISTS mx_message_reactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id UUID NOT NULL REFERENCES mx_messages(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES mx_users(id) ON DELETE CASCADE,
        emoji VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(message_id, user_id, emoji)
      );

      CREATE INDEX IF NOT EXISTS idx_mx_reactions_message ON mx_message_reactions(message_id);
    `,
  },
  {
    name: 'create_typing_indicators',
    sql: `
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
    `,
  },
  {
    name: 'create_webhook_logs',
    sql: `
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
    `,
  },
  {
    name: 'create_rate_limits',
    sql: `
      CREATE TABLE IF NOT EXISTS mx_rate_limits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(255) UNIQUE NOT NULL,
        count INTEGER DEFAULT 1,
        window_start TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mx_rate_limits_key ON mx_rate_limits(key);
      CREATE INDEX IF NOT EXISTS idx_mx_rate_limits_expires ON mx_rate_limits(expires_at);
    `,
  },
  {
    name: 'create_api_keys',
    sql: `
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
    `,
  },
  {
    name: 'create_analytics_events',
    sql: `
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
    `,
  },
];

async function runMigrations() {
  const client = await pool.connect();
  try {
    console.log('Starting database migrations...');

    for (const migration of migrations) {
      console.log(`Running migration: ${migration.name}`);
      await client.query(migration.sql);
      console.log(`✓ Migration ${migration.name} completed`);
    }

    console.log('\n✅ All migrations completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((error) => {
  console.error(error);
  process.exit(1);
});
