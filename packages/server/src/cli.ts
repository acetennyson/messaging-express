#!/usr/bin/env node
/**
 * messaging-express migrate --database-url <url> [--schema <name>] [--dry-run]
 *
 * Creates or upgrades the tables. `--dry-run` prints the pending steps and changes nothing. The CLI reads no environment
 * variables: pass the URL explicitly (e.g. --database-url "$DATABASE_URL").
 */
import { MessagingServer } from './server';

const HELP = `Usage: messaging-express migrate --database-url <url> [--schema <name>] [--dry-run]

  --database-url   Postgres connection string (required)
  --schema         Schema for the tables (default: messaging)
  --dry-run        List the pending steps and change nothing
`;

export async function main(argv: string[], out: (line: string) => void = console.log): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'migrate') {
    out(HELP);
    return command === undefined || command === '--help' || command === '-h' ? 0 : 2;
  }
  let databaseUrl: string | undefined;
  let schema: string | undefined;
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--database-url') databaseUrl = rest[++i];
    else if (a === '--schema') schema = rest[++i];
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--help' || a === '-h') {
      out(HELP);
      return 0;
    } else {
      out(`Unknown argument: ${a}\n\n${HELP}`);
      return 2;
    }
  }
  if (!databaseUrl) {
    out(`--database-url is required\n\n${HELP}`);
    return 2;
  }
  try {
    const result = await MessagingServer.migrate({ database: databaseUrl, schema, dryRun, logger: { debug() {}, info: (m) => out(m), warn: (m) => out(m), error: (m) => out(m) } });
    if (dryRun) out(result.pending.length ? `Pending steps (${result.pending.length}):\n${result.pending.map((n) => `  ${n}`).join('\n')}` : 'Up to date: nothing pending.');
    else out(result.applied.length ? `Applied ${result.applied.length} step(s).` : 'Up to date: nothing to apply.');
    return 0;
  } catch (error) {
    out(`migrate failed: ${(error as Error).message}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
