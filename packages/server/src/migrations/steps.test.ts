import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { steps } from './steps';
import { checksum } from './runner';

/**
 * steps.snapshot.json freezes every step that has shipped. A step's SQL must never change once released (databases have
 * recorded its checksum and would refuse to start). New steps go at the END; add them to the snapshot in the same commit.
 * Never regenerate the snapshot to make a failing test pass: a failure here means a shipped step was edited.
 */
const snapshot: Record<string, string> = JSON.parse(readFileSync(join(__dirname, 'steps.snapshot.json'), 'utf8'));

describe('migration steps', () => {
  it('are numbered 0001.. in order, with unique names', () => {
    steps.forEach((s, i) => expect(s.name.startsWith(String(i + 1).padStart(4, '0') + '_')).toBe(true));
    expect(new Set(steps.map((s) => s.name)).size).toBe(steps.length);
  });

  it('every shipped step is unchanged and still present', () => {
    const now = Object.fromEntries(steps.map((s) => [s.name, checksum(s.sql)]));
    for (const [name, sum] of Object.entries(snapshot)) expect(now[name], name).toBe(sum);
  });

  it('every step is in the snapshot (new steps must be added to it)', () => {
    expect(steps.map((s) => s.name)).toEqual(Object.keys(snapshot));
  });
});
