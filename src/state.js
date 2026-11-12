import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './exec.js';

const FILE = 'contribution-farmer.json';

/**
 * Progress is stored inside .git/ so it follows the checkout but can never be committed by accident.
 */
export function gitDir(cwd = process.cwd()) {
  const res = run('git', ['rev-parse', '--absolute-git-dir'], { cwd, allowFail: true });
  return res.ok ? res.stdout : null;
}

export function repoRoot(cwd = process.cwd()) {
  const res = run('git', ['rev-parse', '--show-toplevel'], { cwd, allowFail: true });
  return res.ok ? res.stdout : null;
}

export function loadState(cwd = process.cwd()) {
  const dir = gitDir(cwd);
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
  } catch {
    return null;
  }
}

export function saveState(state, cwd = process.cwd()) {
  const dir = gitDir(cwd);
  if (!dir) throw new Error('Not inside a git repository');
  writeFileSync(join(dir, FILE), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}

export function scratchPath(name, cwd = process.cwd()) {
  return join(gitDir(cwd), name);
}
