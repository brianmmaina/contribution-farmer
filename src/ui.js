import * as p from '@clack/prompts';
import pc from 'picocolors';
import { runInteractive } from './exec.js';

export { p, pc };

/** Await a prompt; exit cleanly if the user hits Ctrl+C / Esc. */
export async function ask(promise) {
  const value = await promise;
  if (p.isCancel(value)) {
    p.cancel('Stopped. Run the command again any time.');
    process.exit(0);
  }
  return value;
}

export const icon = {
  pass: pc.green('✔'),
  warn: pc.yellow('▲'),
  fail: pc.red('✖'),
  info: pc.cyan('●'),
};

export function truncate(s, n) {
  s = (s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function preview(markdown, maxLines = 18) {
  const lines = (markdown ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''));
  const out = lines.slice(0, maxLines).map((l) => truncate(l, 100));
  if (lines.length > maxLines) out.push(pc.dim(`… ${lines.length - maxLines} more lines`));
  return out.join('\n').trim() || pc.dim('(no description)');
}

/**
 * Run a project command with the user's terminal attached.
 * On failure, let them retry, skip, or stop — never silently push on.
 */
export async function runStep(cmd, cwd) {
  for (;;) {
    p.log.step(pc.bold(`$ ${cmd}`));
    const code = await runInteractive(cmd, { cwd });
    if (code === 0) {
      p.log.success(`${cmd} ${pc.dim('— ok')}`);
      return 'ok';
    }
    p.log.error(`${cmd} exited with code ${code}`);
    const next = await ask(
      p.select({
        message: 'What now?',
        options: [
          { value: 'retry', label: 'Retry', hint: 'after fixing something in another terminal' },
          { value: 'skip', label: 'Skip this command' },
          { value: 'stop', label: 'Stop here' },
        ],
      }),
    );
    if (next === 'skip') return 'failed';
    if (next === 'stop') {
      p.cancel('Stopped. Run the same command again when ready.');
      process.exit(1);
    }
  }
}
