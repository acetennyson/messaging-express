import { migrate } from '../packages/server/src/migrations/runner';

/**
 * The hosted server's migration entry point. It runs the SAME runner as MessagingServer.migrate (numbered steps, a version
 * table, an advisory lock on one dedicated connection), so the hosted server and the embedded module cannot drift. No schema is
 * passed: tables go where the connection's own search_path points, exactly as before.
 */
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is not set');
  process.exit(1);
}

console.log('Starting database migrations...');
migrate(DATABASE_URL, { log: (line) => console.log(line) })
  .then((r) => {
    console.log(r.applied.length ? `\n✅ All migrations completed successfully! (${r.applied.length} applied)` : '\n✅ All migrations completed successfully! (already up to date)');
  })
  .catch((error) => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });
