// Runs scripts/crosscheck.py with whichever Python the machine has (python3, python, or the Windows launcher `py -3`).
// First time:  pip install pynacl cryptography argon2-cffi      (use `python -m pip ...` or `py -3 -m pip ...` on Windows)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'crosscheck.py');
const candidates = [['python3'], ['python'], ['py', '-3']];
for (const [cmd, ...pre] of candidates) {
  const r = spawnSync(cmd, [...pre, script], { stdio: 'inherit' });
  if (r.error) continue; // not installed: try the next one
  process.exit(r.status ?? 1);
}
console.error('No Python found (tried python3, python, py -3). Install Python 3, then: pip install pynacl cryptography argon2-cffi');
process.exit(2);
