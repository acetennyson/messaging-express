// Starts child processes the same way on Linux, macOS and Windows, including when the project sits in a folder with spaces
// (C:\Users\Ado Daniel NJ\...). Used by build-package.mjs and the smoke scripts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const win = process.platform === 'win32';
const quote = (a) => {
  const s = String(a);
  if (s.includes('"')) throw new Error(`run(): an argument contains a double quote: ${s}`);
  return `"${s}"`;
};

/** Runs `cmd args` and returns its stdout as a string. `cmd` may be `npm.cmd` on Windows. Never passes arguments through a shell on Linux/macOS. */
export function run(cmd, args = [], cwd, env) {
  const opts = { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] };
  if (win && /\.(cmd|bat)$/i.test(cmd)) {
    // A .cmd file can only run through cmd.exe. Quote the program and every argument, so spaces in paths survive.
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[cmd, ...args].map(quote).join(' ')}"`], { ...opts, windowsVerbatimArguments: true });
  }
  return execFileSync(cmd, args, opts);
}

/**
 * Finds npm's own JavaScript entry point. Running it with this Node avoids npm.cmd, which on Windows works out its folder wrongly
 * when it is started by bare name from another directory.
 */
function findNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows installer, nvm-windows
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Linux, macOS, nvm
  ];
  return candidates.find((c) => c && /npm-cli\.js$/.test(c) && fs.existsSync(c));
}

/** Absolute path of a program found on PATH (Windows: tries .cmd/.exe), so a batch file is started by its full path. */
function onPath(name) {
  const exts = win ? ['.cmd', '.exe', '.bat'] : [''];
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    for (const e of exts) { const f = path.join(dir, name + e); if (dir && fs.existsSync(f)) return f; }
  }
  return undefined;
}

/** `npm <args>` in `cwd`; returns stdout. */
export function runNpm(args, cwd, env) {
  const cli = findNpmCli();
  if (cli) return run(process.execPath, [cli, ...args], cwd, env);
  const npm = onPath('npm');
  if (!npm) throw new Error('npm was not found. Install Node.js with npm, or run this script through `npm run`.');
  return run(npm, args, cwd, env);
}
