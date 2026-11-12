import { run } from '../exec.js';
import { gatherBranchFacts, evaluate, summarize } from '../lib/checks.js';
import { loadState, saveState, repoRoot } from '../state.js';
import { ask, p, pc, icon, runStep } from '../ui.js';

export function requireState() {
  const state = loadState();
  if (!state) {
    throw new Error('No contribution in progress here. cd into the project folder, or run `npx contribution-farmer` to start one.');
  }
  return state;
}

/** Reviewer-style checklist for the current branch, optionally running the project's tests and linters. */
export async function check({ runCommands = true, silent = false } = {}) {
  const state = requireState();
  const root = repoRoot();
  const upstreamRef = `${state.upstreamRemote}/${state.defaultBranch}`;

  const s = p.spinner();
  s.start(`Comparing your branch with ${upstreamRef}`);
  run('git', ['fetch', state.upstreamRemote, state.defaultBranch], { cwd: root, allowFail: true });
  const facts = gatherBranchFacts(root, { upstreamRef });
  const items = evaluate(facts, { conventions: state.conventions, defaultBranch: state.defaultBranch, issueNumber: state.issue?.number });
  s.stop('Branch analysed');

  const commands = [...(state.commands.test ?? []), ...(state.commands.lint ?? [])];
  const results = {};
  if (runCommands && commands.length && facts.ahead > 0) {
    const go = await ask(p.confirm({ message: `Run tests and linters? ${pc.dim(commands.join(' · '))}`, initialValue: true }));
    if (go) {
      for (const cmd of commands) {
        results[cmd] = await runStep(cmd, root);
        const before = state.baseline?.[cmd];
        if (results[cmd] === 'ok') items.push({ level: 'pass', title: `${cmd} passes` });
        else if (before === 'failed') items.push({ level: 'warn', title: `${cmd} fails`, detail: 'It was already failing before your change (baseline) — mention this in the PR.' });
        else items.push({ level: 'fail', title: `${cmd} fails`, detail: 'Fix this before opening the PR. CI will run the same thing.' });
      }
    }
  }

  if (!silent) printChecklist(items);
  const summary = summarize(items);
  const lastCheck = { at: new Date().toISOString(), summary, results: Object.keys(results).length ? results : state.lastCheck?.results ?? {} };
  const next = { ...state, lastCheck };
  saveState(next, root);

  if (!silent) {
    if (summary.fail) {
      p.outro(pc.red(`${summary.fail} thing(s) to fix before opening a PR.`));
      process.exitCode = 1;
    }
    else if (summary.warn) p.outro(pc.yellow(`No blockers. Look over the ${summary.warn} warning(s), then run ${pc.cyan('npx contribution-farmer pr')}.`));
    else p.outro(pc.green(`Looks great. Run ${pc.cyan('npx contribution-farmer pr')} when ready.`));
  }
  return { items, summary, facts, state: next };
}

export function printChecklist(items) {
  for (const item of items) {
    const text = item.detail ? `${item.title}\n${pc.dim(item.detail)}` : item.title;
    p.log.message(text, { symbol: icon[item.level] ?? icon.info });
  }
}
