import { run } from '../exec.js';
import { repoRoot } from '../state.js';
import { p, pc, icon } from '../ui.js';
import { requireState } from './check.js';

export async function status() {
  const state = requireState();
  const root = repoRoot();
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  const ahead = Number(run('git', ['rev-list', '--count', `${state.upstreamRemote}/${state.defaultBranch}..HEAD`], { cwd: root, allowFail: true }).stdout || 0);
  const dirty = run('git', ['status', '--porcelain'], { cwd: root }).split('\n').filter(Boolean).length;

  const lines = [
    `${pc.bold('Project')}    ${state.upstream}`,
    `${pc.bold('Issue')}      #${state.issue.number} ${state.issue.title}`,
    `           ${pc.dim(state.issue.url)}`,
    `${pc.bold('Branch')}     ${branch}${branch !== state.branch ? pc.yellow(` (expected ${state.branch})`) : ''}`,
    `${pc.bold('Commits')}    ${ahead} ahead of ${state.upstreamRemote}/${state.defaultBranch}${dirty ? pc.yellow(` · ${dirty} uncommitted file(s)`) : ''}`,
  ];
  if (state.lastCheck) {
    const { fail, warn } = state.lastCheck.summary;
    lines.push(`${pc.bold('Last check')} ${fail ? `${icon.fail} ${fail} failing` : `${icon.pass} no blockers`}${warn ? ` · ${warn} warning(s)` : ''} ${pc.dim(new Date(state.lastCheck.at).toLocaleString())}`);
  }
  if (state.prUrl) lines.push(`${pc.bold('PR')}         ${state.prUrl}`);
  p.note(lines.join('\n'), 'Your contribution');

  let next;
  if (state.prUrl) next = 'Respond to review comments and keep CI green.';
  else if (ahead === 0) next = 'Make your change and commit it.';
  else if (!state.lastCheck || state.lastCheck.summary.fail) next = `Run ${pc.cyan('npx contribution-farmer check')}.`;
  else next = `Run ${pc.cyan('npx contribution-farmer pr')}.`;
  p.outro(`Next: ${next}`);
}
