import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, runLive, runInteractive } from '../exec.js';
import { buildPRBody, suggestTitle } from '../lib/prbody.js';
import { saveState, repoRoot, scratchPath } from '../state.js';
import { ask, p, pc } from '../ui.js';
import { check, printChecklist } from './check.js';

export async function pr() {
  const { items, summary, facts, state } = await check({ runCommands: false, silent: true });
  const root = repoRoot();

  printChecklist(items.filter((i) => i.level !== 'pass'));
  if (facts.ahead === 0) {
    p.outro('Commit your change first.');
    return;
  }
  if (summary.fail) {
    const go = await ask(p.confirm({ message: `${summary.fail} check(s) failing. Open the PR anyway?`, initialValue: false }));
    if (!go) {
      p.outro(`Fix them, then run ${pc.cyan('npx contribution-farmer check')}.`);
      return;
    }
  }
  const tested = Object.entries(state.lastCheck?.results ?? {})
    .filter(([, r]) => r === 'ok')
    .map(([cmd]) => cmd);
  if (!tested.length) {
    p.log.warn(`You haven't run the tests through ${pc.cyan('check')} yet — reviewers will ask how you tested this.`);
  }

  const title = await ask(
    p.text({
      message: 'PR title',
      initialValue: suggestTitle({ commits: facts.commits, issue: state.issue, commitStyle: state.conventions?.commitStyle }),
      validate: (v) => (!v || v.trim().length < 10 ? 'Make it descriptive — reviewers scan titles' : undefined),
    }),
  );

  const templatePath = state.conventions?.prTemplates?.[0];
  let template = null;
  if (templatePath) {
    try {
      template = readFileSync(join(root, templatePath), 'utf8');
    } catch {}
  }
  const bodyFile = scratchPath('contribution-farmer-pr.md', root);
  writeFileSync(bodyFile, buildPRBody({ template, issueNumber: state.issue?.number, commits: facts.commits, tested }));
  p.log.info(`Drafted the description${template ? ` from ${templatePath}` : ''}: ${pc.dim(bodyFile)}`);

  const editor = process.env.VISUAL || process.env.EDITOR;
  if (editor) {
    const edit = await ask(p.confirm({ message: `Open it in ${editor} to fill in the details?`, initialValue: true }));
    if (edit) await runInteractive(`${editor} "${bodyFile}"`, { cwd: root });
  } else {
    p.log.message(pc.dim('Tip: set $EDITOR to edit the description here. Otherwise edit it in the browser.'));
  }

  const pushOk = await ask(
    p.confirm({ message: `Push ${pc.cyan(facts.branch)} to ${state.pushRemote}${state.forkOwner ? ` (${state.forkOwner}'s fork)` : ''}?`, initialValue: true }),
  );
  if (!pushOk) return;
  const code = await runLive('git', ['push', '-u', state.pushRemote, facts.branch], { cwd: root });
  if (code !== 0) throw new Error('git push failed');

  const mode = await ask(
    p.select({
      message: 'How do you want to open the PR?',
      options: [
        { value: 'web', label: 'Open pre-filled in the browser', hint: 'recommended — review it once more, then click Create' },
        { value: 'draft', label: 'Create as a draft PR now', hint: 'mark ready for review when you are happy' },
        { value: 'ready', label: 'Create and request review now' },
      ],
    }),
  );
  const head = state.forkOwner ? `${state.forkOwner}:${facts.branch}` : facts.branch;
  const args = ['pr', 'create', '--repo', state.upstream, '--base', state.defaultBranch, '--head', head, '--title', title, '--body-file', bodyFile];
  if (mode === 'web') {
    args.push('--web');
    await runLive('gh', args, { cwd: root });
  } else {
    if (mode === 'draft') args.push('--draft');
    const url = run('gh', args, { cwd: root });
    p.log.success(`PR opened: ${pc.cyan(url)}`);
    saveState({ ...state, prUrl: url }, root);
  }

  p.note(
    [
      '• CI will run on your PR — if it goes red, fix it before pinging anyone.',
      `• ${state.conventions?.cla ? 'A CLA bot will comment — sign it so your PR can be merged.' : 'Watch for bot comments (CLA, labels, coverage) and act on them.'}`,
      '• Reply to every review comment, even just "Done". Push fixes as new commits unless asked to squash.',
      '• No reply after a week? One polite ping on the PR is fine. Maintainers are often volunteers.',
      '• Don’t open a second PR for the same issue — update this one.',
    ].join('\n'),
    'After you open it',
  );
  p.outro('Nice work. 🌾');
}
