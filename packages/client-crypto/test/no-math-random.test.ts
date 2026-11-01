import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The plan forbids Math.random in src/ (keys and nonces must come from the platform CSPRNG). A scan is cheaper and more portable than a lint rule.
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });

describe('randomness discipline', () => {
  it('no source file calls Math.random', () => {
    const offenders = walk(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).filter((f) => /Math\s*\.\s*random\s*\(/.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
    expect(offenders).toEqual([]);
  });
});
