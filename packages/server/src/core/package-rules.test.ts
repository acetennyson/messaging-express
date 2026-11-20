import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Rules the server package keeps about itself, so it stays embeddable. Each one is a way a "core" quietly turns back into
 * a Next.js app: reading the environment, keeping process-wide state, importing the framework, or reaching outside its
 * own folder. (The hosted server's own rules live in lib/hosted/guards.test.ts.)
 */
const SRC = path.join(__dirname, '..');
const PKG_JSON = JSON.parse(readFileSync(path.join(SRC, '..', 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.ts$/.test(name)) yield full;
  }
}
const isTest = (f: string) => /\.test\.ts$/.test(f);
const production = () => [...files(SRC)].filter((f) => !isTest(f));
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');

function scan(list: string[], re: RegExp, allowed: (r: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const file of list) {
    if (allowed(rel(file))) continue;
    stripComments(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        if (re.test(line)) out.push(`${rel(file)}:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
  }
  return out;
}

describe('the server package keeps to itself', () => {
  it('every table reference goes through db.t(...) (no raw mx_<table>; column qualifiers like mx_x.col are fine)', () => {
    // A raw name would silently resolve through the CUSTOMER's search_path when the pool is borrowed.
    expect(scan(production(), /\bmx_[a-z][a-z0-9_]*\b(?!\.)/, (r) => r === 'core/db.ts' || r === 'migrations/steps.ts')).toEqual([]);
  });

  it('reads no process.env (configuration comes through ctx.config); only the test helper may', () => {
    expect(scan(production(), /\bprocess\.env\b/, (r) => r === 'core/testing.ts')).toEqual([]);
  });

  it('keeps no process-wide state (no globalThis, no Symbol.for registry): state lives on the ServerContext', () => {
    expect(scan(production(), /\bglobalThis\b|Symbol\.for\(/)).toEqual([]);
  });

  it('never imports Next.js', () => {
    expect(scan([...files(SRC)], /from\s+['"]next(\/[^'"]*)?['"]|require\(\s*['"]next(\/|['"])|import\(\s*['"]next(\/|['"])/, (r) => r === 'core/package-rules.test.ts')).toEqual([]);
  });

  it("uses no path alias ('@/…' or its own package name): relative imports only, so tsc, tsx and consumers all resolve it", () => {
    expect(scan([...files(SRC)], /(from|import\()\s*['"](@\/|@messaging-express\/server)/, (r) => r === 'core/package-rules.test.ts')).toEqual([]);
  });

  it('production code never imports outside the package folder', () => {
    const out: string[] = [];
    for (const file of production()) {
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"](\.[^'"]*)['"]/g)) {
            const target = path.resolve(path.dirname(file), m[1]);
            if (!target.startsWith(SRC + path.sep)) out.push(`${rel(file)}:${i + 1}: ${m[1]}`);
          }
        });
    }
    expect(out).toEqual([]);
  });

  it('every external import in production code is declared in package.json (dependencies or peerDependencies)', () => {
    const declared = new Set([...Object.keys(PKG_JSON.dependencies), ...Object.keys(PKG_JSON.peerDependencies ?? {})]);
    const builtins = new Set(['fs', 'path', 'crypto', 'http', 'https', 'net', 'os', 'url', 'stream', 'zlib', 'util', 'events', 'buffer', 'child_process', 'perf_hooks', 'assert', 'timers', 'tls', 'dns', 'readline', 'worker_threads', 'querystring', 'string_decoder', 'vm']);
    const missing = new Set<string>();
    for (const file of production().filter((f) => !/\/core\/testing(-logger)?\.ts$/.test(f.split(path.sep).join('/')))) {
      for (const m of stripComments(readFileSync(file, 'utf8')).matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"]([^.'"][^'"]*)['"]/g)) {
        const spec = m[1];
        if (spec.startsWith('node:')) continue;
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!builtins.has(name) && !declared.has(name)) missing.add(`${name} (${rel(file)})`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('has a barrel (src/index.ts) that exists and exports the context type', () => {
    expect(existsSync(path.join(SRC, 'index.ts'))).toBe(true);
    expect(readFileSync(path.join(SRC, 'index.ts'), 'utf8')).toMatch(/ServerContext/);
  });
});
