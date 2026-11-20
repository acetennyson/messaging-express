import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { routes } from '@messaging-express/server/core/routes';

/**
 * Rules for the hosted shell (the Next.js app + server.ts + lib/hosted). The server package keeps its own rules in
 * packages/server/src/core/package-rules.test.ts.
 */
const ROOT = path.join(__dirname, '../..');
const SKIP = new Set(['node_modules', '.next', 'dist', 'packages', 'scripts', 'docs', 'public']);

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP.has(name)) yield* files(full);
    } else if (/\.tsx?$/.test(name)) yield full;
  }
}
const isTest = (f: string) => /\.test\.tsx?$/.test(f);
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');
const hostedProduction = () => [...files(path.join(ROOT, 'app')), ...files(path.join(ROOT, 'lib')), path.join(ROOT, 'server.ts')].filter((f) => !isTest(f));
const serverCompiled = () => [...files(path.join(ROOT, 'lib', 'hosted')), path.join(ROOT, 'server.ts')].filter((f) => !isTest(f));

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

describe('hosted shell rules', () => {
  it('no raw mx_<table> anywhere in the hosted code (all SQL lives in the server package)', () => {
    expect(scan(hostedProduction(), /\bmx_[a-z][a-z0-9_]*\b(?!\.)/)).toEqual([]);
  });

  it("code compiled by the plain tsc server build (server.ts, lib/hosted) imports the package by relative path, never an alias", () => {
    expect(scan(serverCompiled(), /(from|import\()\s*['"](@\/|@messaging-express\/server)/)).toEqual([]);
  });

  it('process.env is read only by lib/hosted and server.ts', () => {
    expect(scan(hostedProduction(), /\bprocess\.env\b/, (r) => r === 'server.ts' || r.startsWith('lib/hosted/'))).toEqual([]);
  });

  it('only the hosted context and server.ts import the env-driven pool', () => {
    const ok = (r: string) => r === 'server.ts' || r === 'lib/hosted/context.ts' || r === 'lib/hosted/pool.ts';
    expect(scan(hostedProduction(), /from\s+['"][^'"]*\/pool['"]|import\(\s*['"][^'"]*\/pool['"]/, ok)).toEqual([]);
  });

  it('Next is imported only by lib/hosted, server.ts and the non-API app pages (route files are plain dispatchers)', () => {
    const ok = (r: string) => r === 'server.ts' || r.startsWith('lib/hosted/') || (r.startsWith('app/') && !r.startsWith('app/api/') && !r.startsWith('app/uploads/'));
    expect(scan(hostedProduction(), /from\s+['"]next(\/[^'"]*)?['"]|require\(\s*['"]next(\/|['"])/, ok)).toEqual([]);
  });
});

describe('the Next route files and the route table', () => {
  const routeFiles = () => [...files(path.join(ROOT, 'app'))].filter((f) => path.basename(f) === 'route.ts');

  it('every route file is a pure one-liner dispatch (no logic under app/ routes)', () => {
    for (const full of routeFiles()) {
      const lines = readFileSync(full, 'utf8').split('\n').filter((l) => l.trim() !== '');
      const bad = lines.filter((l) => l !== "import { nextRoute } from '@/lib/hosted/next';" && !/^export const \w+ = nextRoute\('\w+', '[^']+'\);$/.test(l));
      expect(bad, full).toEqual([]);
    }
  });

  it('the route files export exactly what the table defines (nothing forgotten, nothing invented)', () => {
    const fromApp: string[] = [];
    for (const full of routeFiles()) {
      for (const m of readFileSync(full, 'utf8').matchAll(/export const (\w+) = nextRoute\('(\w+)', '([^']+)'\);/g)) {
        expect(m[1], `${full}: export name must equal its method`).toBe(m[2]);
        fromApp.push(`${m[2]} ${m[3]}`);
      }
    }
    expect(fromApp.sort()).toEqual(routes.map((r) => `${r.method} ${r.pattern}`).sort());
  });
});
