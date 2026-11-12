import { spawnSync, spawn } from 'node:child_process';

export class CommandError extends Error {
  constructor(cmd, args, result) {
    const stderr = (result.stderr || '').trim();
    super(`${cmd} ${args.join(' ')} failed${stderr ? `:\n${stderr}` : ''}`);
    this.status = result.status;
    this.stderr = stderr;
    this.stdout = (result.stdout || '').trim();
  }
}

/** Run a command and capture output. Throws CommandError on non-zero exit unless allowFail. */
export function run(cmd, args = [], { cwd, input, allowFail = false, env } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    input,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    if (allowFail) return { ok: false, stdout: '', stderr: String(result.error.message), status: -1 };
    throw result.error;
  }
  if (allowFail) {
    return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
  }
  if (result.status !== 0) throw new CommandError(cmd, args, result);
  return result.stdout.trim();
}

/** Run a shell command with the user's terminal attached. Resolves to the exit code. */
export function runInteractive(command, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'inherit' });
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
    child.on('error', () => resolve(127));
  });
}

export function hasCommand(name) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return run(probe, [name], { allowFail: true }).ok;
}

export const git = (args, opts) => run('git', args, opts);

/** Run a command (no shell) with output streamed to the terminal. Resolves to the exit code. */
export function runLive(cmd, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
    child.on('error', () => resolve(127));
  });
}

export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
