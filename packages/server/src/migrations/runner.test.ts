/** M5 integration: versioned migrations against a real Postgres (DATABASE_URL), each test in its own throwaway schema. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { promisify } from 'util';
import { Pool } from 'pg';
import { steps } from './steps';
import { migrate, readStatus, checksum } from './runner';
import { MessagingServer } from '../server';
import { SchemaChecksumError, SchemaNotReadyError, SchemaTooNewError } from '../errors';
import { main } from '../cli';

const URL_ = process.env.TEST_SCHEMA_DATABASE_URL || process.env.DATABASE_URL;
const run = promisify(execFile);
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const SECRET = 'm5-runner-secret-m5-runner-secret-xx';

describe.skipIf(!URL_)('versioned migrations', () => {
  const admin = new Pool({ connectionString: URL_, max: 3 });
  const made: string[] = [];
  let schema = '';

  beforeEach(() => {
    schema = `m5_${randomBytes(4).toString('hex')}`;
    made.push(schema);
  });
  afterAll(async () => {
    for (const s of made) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
  });

  const tableCount = async (s: string) => (await admin.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema = $1`, [s])).rows[0].n as number;
  const recorded = async (s: string) => (await admin.query(`SELECT name FROM ${s}.mx_schema_migrations ORDER BY name`)).rows.map((r) => r.name as string);

  it('fresh database: applies every step once, records them, and a second run does nothing', async () => {
    const first = await migrate(URL_!, { schema });
    expect(first.applied).toHaveLength(steps.length);
    expect(first.pending).toEqual([]);
    expect(await recorded(schema)).toEqual(steps.map((s) => s.name).sort());
    expect((await migrate(URL_!, { schema })).applied).toEqual([]);
    const st = await readStatus(admin, schema);
    expect(st).toEqual({ applied: steps.map((s) => s.name), pending: [], unknown: [], changed: [] });
  });

  it('dry run lists what would run and creates nothing, not even the schema', async () => {
    const r = await MessagingServer.migrate({ database: URL_!, schema, dryRun: true });
    expect(r.pending).toEqual(steps.map((s) => s.name));
    expect((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rowCount).toBe(0);
  });

  it('older database: init refuses with SchemaNotReadyError, autoMigrate completes it', async () => {
    await migrate(URL_!, { schema, steps: steps.slice(0, 5) });
    const refused = await MessagingServer.init({ database: URL_!, jwtSecret: SECRET, schema, logger: silent }).catch((e) => e);
    expect(refused).toBeInstanceOf(SchemaNotReadyError);
    expect(refused.message).toContain('migrate');
    expect(await recorded(schema)).toHaveLength(5); // init did not change anything

    const s = await MessagingServer.init({ database: URL_!, jwtSecret: SECRET, schema, autoMigrate: true, logger: silent });
    expect(await recorded(schema)).toHaveLength(steps.length);
    await s.close({ timeoutMs: 200 });
  });

  it('newer database is always refused, by init (even with autoMigrate) and by migrate', async () => {
    await migrate(URL_!, { schema });
    await admin.query(`INSERT INTO ${schema}.mx_schema_migrations (name, checksum) VALUES ('0099_from_the_future', 'x')`);
    for (const extra of [{}, { autoMigrate: true }]) {
      const err = await MessagingServer.init({ database: URL_!, jwtSecret: SECRET, schema, logger: silent, ...extra }).catch((e) => e);
      expect(err).toBeInstanceOf(SchemaTooNewError);
    }
    await expect(MessagingServer.migrate({ database: URL_!, schema })).rejects.toBeInstanceOf(SchemaTooNewError);
  });

  it('an applied step whose SQL was edited is refused', async () => {
    await migrate(URL_!, { schema });
    await admin.query(`UPDATE ${schema}.mx_schema_migrations SET checksum = 'edited' WHERE name = $1`, [steps[0].name]);
    await expect(migrate(URL_!, { schema })).rejects.toBeInstanceOf(SchemaChecksumError);
  });

  it('concurrent start: in-process and from separate processes, all succeed and each step is recorded once', async () => {
    const cli = ['tsx', 'packages/server/src/cli.ts', 'migrate', '--database-url', URL_!, '--schema', schema];
    const results = await Promise.all([
      migrate(URL_!, { schema }),
      migrate(URL_!, { schema }),
      run('npx', cli, { cwd: process.cwd() }),
      run('npx', cli, { cwd: process.cwd() }),
    ]);
    const applied = results.slice(0, 2).reduce((n, r) => n + (r as { applied: string[] }).applied.length, 0);
    expect(applied).toBeLessThanOrEqual(steps.length); // the lock means nobody ran a step twice
    expect(await recorded(schema)).toEqual(steps.map((s) => s.name).sort());
    expect((await readStatus(admin, schema)).pending).toEqual([]);
  }, 120_000);

  it('a step that fails stops the run, keeps what finished, and a rerun completes it', async () => {
    const broken = [...steps.slice(0, 3), { name: '0004_create_conversations', sql: 'SELECT * FROM table_that_does_not_exist' }];
    await expect(migrate(URL_!, { schema, steps: broken })).rejects.toThrow(/0004_create_conversations failed/);
    expect(await recorded(schema)).toEqual(steps.slice(0, 3).map((s) => s.name));
    expect((await migrate(URL_!, { schema })).applied).toHaveLength(steps.length - 3);
  });

  it('a run killed halfway releases its lock with the connection, and a rerun completes', async () => {
    const slow = [...steps.slice(0, 3), { name: '0004_create_conversations', sql: 'SELECT pg_sleep(60)' }];
    const doomed = migrate(URL_!, { schema, steps: slow }).catch((e) => e);
    let pid: number | undefined;
    for (let i = 0; i < 100 && !pid; i++) {
      const r = await admin.query(`SELECT pid FROM pg_stat_activity WHERE application_name = 'messaging-express-migrate' AND query LIKE '%pg_sleep(60)%'`);
      pid = r.rows[0]?.pid;
      if (!pid) await new Promise((r2) => setTimeout(r2, 100));
    }
    expect(pid).toBeTruthy();
    await admin.query('SELECT pg_terminate_backend($1)', [pid]); // the process "died": its connection is gone
    expect(await doomed).toBeInstanceOf(Error);

    const started = Date.now();
    const again = await migrate(URL_!, { schema }); // would hang here if the lock had not been released
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(again.pending).toEqual([]);
    expect(await recorded(schema)).toEqual(steps.map((s) => s.name).sort());
  }, 60_000);

  it("schema isolation: a customer's own mx_users outside the schema is untouched, and a borrowed pool keeps its search_path", async () => {
    const cust = `cust_${randomBytes(3).toString('hex')}`;
    made.push(cust);
    await admin.query(`CREATE SCHEMA ${cust}`);
    await admin.query(`CREATE TABLE ${cust}.mx_users (id int primary key)`);
    await admin.query(`INSERT INTO ${cust}.mx_users VALUES (7)`);
    const publicBefore = (await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).rows;

    // the customer's pool resolves unqualified names to THEIR schema
    const mine = new Pool({ connectionString: URL_, max: 2, options: `-c search_path=${cust}` });
    const before = (await mine.query('SHOW search_path')).rows[0].search_path;
    await migrate(mine, { schema });
    expect((await mine.query('SHOW search_path')).rows[0].search_path).toBe(before); // the dedicated connection was destroyed
    expect((await mine.query('SELECT id FROM mx_users')).rows).toEqual([{ id: 7 }]);
    await mine.end();

    expect((await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'mx_users'`, [cust])).rows).toEqual([{ column_name: 'id' }]);
    expect(await tableCount(cust)).toBe(1);
    expect((await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).rows).toEqual(publicBefore);
    expect(await tableCount(schema)).toBe(17 + 1); // the 17 tables the steps create, plus the version table
  });

  it('the hosted script path (scripts/migrate.ts) uses the same runner and is idempotent', async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const env = { ...process.env, DATABASE_URL: URL_!, PGOPTIONS: `-c search_path=${schema}` };
    const a = await run('npx', ['tsx', 'scripts/migrate.ts'], { cwd: process.cwd(), env });
    expect(a.stdout).toContain('All migrations completed successfully');
    const b = await run('npx', ['tsx', 'scripts/migrate.ts'], { cwd: process.cwd(), env });
    expect(b.stdout).toContain('already up to date');
    expect(await recorded(schema)).toEqual(steps.map((s) => s.name).sort());
  }, 60_000);

  it('CLI: dry run, missing argument and exit codes', async () => {
    const lines: string[] = [];
    expect(await main(['migrate', '--dry-run', '--database-url', URL_!, '--schema', schema], (l) => lines.push(l))).toBe(0);
    expect(lines.join('\n')).toContain(`Pending steps (${steps.length})`);
    expect(await main(['migrate'], () => {})).toBe(2);
    expect(await main(['bogus'], () => {})).toBe(2);
    expect(await main(['migrate', '--database-url', URL_!, '--schema', 'Bad Name'], (l) => lines.push(l))).toBe(1);
    expect(checksum('a')).toHaveLength(64);
  });
});
