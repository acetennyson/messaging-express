-- Idempotent seed for scripts/smoke.sh. Fixed UUIDs so the smoke script can
-- find its fixtures. Safe to run repeatedly. DEV / STAGING DATABASES ONLY.
--
--   psql "$DATABASE_URL" -f scripts/smoke-seed.sql

INSERT INTO organizations (id, name, slug, api_key, api_secret_hash)
VALUES ('00000000-0000-4000-8000-0000000000a1', 'Smoke Org', 'smoke-org', 'smoke-org-key', 'not-a-real-hash')
ON CONFLICT DO NOTHING;

INSERT INTO projects (id, organization_id, name, api_key)
VALUES ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a1', 'Smoke Project', 'smoke-project-key')
ON CONFLICT DO NOTHING;

INSERT INTO users (id, project_id, external_id, name, email)
VALUES
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a2', 'smoke-user-1', 'Smoke One', 'smoke1@example.com'),
  ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000a2', 'smoke-user-2', 'Smoke Two', 'smoke2@example.com')
ON CONFLICT DO NOTHING;

INSERT INTO conversations (id, project_id, type, title)
VALUES ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a2', 'direct', 'Smoke conversation')
ON CONFLICT DO NOTHING;

INSERT INTO conversation_participants (conversation_id, user_id)
VALUES
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b1'),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b2')
ON CONFLICT DO NOTHING;
