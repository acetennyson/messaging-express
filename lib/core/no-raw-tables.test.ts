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
