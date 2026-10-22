-- ONE-TIME: only for a database where Messaging Express was ALREADY migrated with the old
-- unprefixed table names. New installs don't need this (migrate.ts now creates mx_* tables).
--
--   1. Stop traffic or accept a brief window: the app code uses mx_* names, so deploy the new
--      code and run this script back to back (renames are instant and keep data, FKs and indexes).
--   2. psql "$DATABASE_URL" -f scripts/rename-to-mx-prefix.sql
--
-- Safety: refuses to run if public.users is not ours (e.g. it belongs to another project that
-- shares this database), and skips tables that are already renamed. Runs in one transaction.
BEGIN;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'organizations','projects','users','conversations','conversation_participants',
    'messages','message_attachments','message_reactions','typing_indicators',
    'webhook_logs','rate_limits','api_keys','analytics_events'];
BEGIN
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'project_id'
  ) THEN
    RAISE EXCEPTION 'public.users is not a Messaging Express table (no project_id column); refusing to rename anything';
  END IF;

  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NOT NULL AND to_regclass('public.mx_' || t) IS NULL THEN
      EXECUTE format('ALTER TABLE public.%I RENAME TO %I', t, 'mx_' || t);
      RAISE NOTICE 'renamed % -> mx_%', t, t;
    ELSE
      RAISE NOTICE 'skipped % (missing, or mx_% already exists)', t, t;
    END IF;
  END LOOP;
END $$;

COMMIT;
