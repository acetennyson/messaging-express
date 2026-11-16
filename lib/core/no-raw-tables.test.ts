import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Isolation rule: every table reference goes through `db.t('name')`, so a configured schema is always honoured and
 * a borrowed pg.Pool is never relied on for `search_path`. A raw `mx_<table>` in source would silently resolve through
 * the CUSTOMER's search_path. Column qualifiers (`mx_rate_limits.count`) are allowed: they refer to a table that
 * is already named, schema-qualified, in the same statement.
 */
const ROOT = path.join(__dirname, '../..');
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'packages', 'scripts', 'docs', 'public']);

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* sourceFiles(full);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      yield full;
    }
  }
}

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('table references', () => {
  it('no raw mx_<table> outside lib/core/db.ts (use db.t(...))', () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(path.join(ROOT, 'app')), ...sourceFiles(path.join(ROOT, 'lib')), path.join(ROOT, 'server.ts')]) {
      if (file.endsWith(path.join('lib', 'core', 'db.ts'))) continue;
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (/\bmx_[a-z][a-z0-9_]*\b(?!\.)/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('imports', () => {
  it("lib/ and server.ts use relative imports, not the '@/' alias (the server build and the embedded package cannot resolve it)", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(path.join(ROOT, 'lib')), path.join(ROOT, 'server.ts')]) {
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (/from\s+'@\//.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('environment access', () => {
  // The core reads configuration only through ctx.config. `process.env` may appear in the hosted wrapper and at the
  // process edge (server.ts). The one leftover below is lib/db/pool.ts (hosted-only, see the next test); this list may only shrink.
  const ALLOWED = [
    path.join('lib', 'hosted') + path.sep,
    path.join('lib', 'core', 'testing.ts'),
    path.join('lib', 'db', 'pool.ts'),
    'server.ts',
  ];

  it('no process.env outside the hosted wrapper, the process edge and the hosted pool', () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(path.join(ROOT, 'app')), ...sourceFiles(path.join(ROOT, 'lib')), path.join(ROOT, 'server.ts')]) {
      const rel = path.relative(ROOT, file);
      if (ALLOWED.some((a) => rel === a || rel.startsWith(a))) continue;
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (/\bprocess\.env\b/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('hosted-only wiring stays out of the core', () => {
  const production = () =>
    [...sourceFiles(path.join(ROOT, 'app')), ...sourceFiles(path.join(ROOT, 'lib')), path.join(ROOT, 'server.ts')].filter(
      (f) => !/\.test\.tsx?$/.test(f)
    );
  const scan = (re: RegExp, allowed: (rel: string) => boolean): string[] => {
    const offenders: string[] = [];
    for (const file of production()) {
      const rel = path.relative(ROOT, file);
      if (allowed(rel)) continue;
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (re.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
        });
    }
    return offenders;
  };

  it('only the hosted context and server.ts import the env-driven pool (lib/db/pool)', () => {
    const ok = (rel: string) => rel === 'server.ts' || rel === path.join('lib', 'hosted', 'context.ts') || rel === path.join('lib', 'db', 'pool.ts');
    expect(scan(/from\s+['"][^'"]*db\/pool['"]|import\(\s*['"][^'"]*db\/pool['"]/, ok)).toEqual([]);
  });

  it('no globalThis singletons outside lib/hosted (state lives on the context)', () => {
    expect(scan(/\bglobalThis\b|Symbol\.for\(/, (rel) => rel.startsWith(path.join('lib', 'hosted') + path.sep))).toEqual([]);
  });

  it('the core never imports next/server `after` (ctx.defer does that)', () => {
    expect(scan(/\bafter\b[^\n]*from\s+['"]next\/server['"]/, (rel) => rel.startsWith(path.join('lib', 'hosted') + path.sep))).toEqual([]);
  });
});
