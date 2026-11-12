import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { run, runLive, sleep } from '../exec.js';
import { fetchRepo, fetchIssues, fetchIssue, parseRepoRef, rest, viewerLogin } from '../github.js';
import { scoreRepo, beginnerLabels, daysSince } from '../lib/health.js';
import { rankIssues, assessIssue, branchNameFor, templatedShare } from '../lib/issues.js';
import { findContributingDoc, extractCommands, extractRules } from '../lib/contributing.js';
import { detectToolchain, mergeCommands, checkRuntimes } from '../lib/toolchain.js';
import { detectConventions, commitExample } from '../lib/conventions.js';
import { extractSearchTerms, findRelevantFiles } from '../lib/hints.js';
import { loadState, saveState } from '../state.js';
import { ask, p, pc, icon, truncate, preview, runStep } from '../ui.js';
import { find, gradeBadge } from './find.js';

export async function start(target, opts = {}) {
  let ref = parseRepoRef(target);
  if (target && !ref) throw new Error(`Couldn't understand "${target}". Use owner/repo or a GitHub URL.`);

  if (!ref) {
    const here = loadState();
    if (here?.upstream) {
      p.log.info(`You're already inside a contribution to ${pc.bold(here.upstream)}. Use ${pc.cyan('status')}, ${pc.cyan('check')} or ${pc.cyan('pr')}.`);
      return;
    }
    const how = await ask(
      p.select({
        message: 'Where do you want to contribute?',
        options: [
          { value: 'find', label: 'Help me find a good project', hint: 'searches beginner issues in active repos' },
          { value: 'have', label: 'I have a repo in mind' },
        ],
      }),
    );
    if (how === 'find') ref = await find(opts);
    else {
      const input = await ask(p.text({ message: 'Repo (owner/name or URL)', validate: (v) => (parseRepoRef(v) ? undefined : 'Expected owner/repo or a GitHub URL') }));
      ref = parseRepoRef(input);
    }
    if (!ref) return;
  }

  // 1. Is this repo a good place to contribute right now?
  const s = p.spinner();
  s.start(`Looking at ${ref.owner}/${ref.name}`);
  const repo = fetchRepo(ref.owner, ref.name);
  if (!repo) {
    s.error('Repository not found');
    return;
  }
  const health = scoreRepo(repo);
  s.stop(`${pc.bold(repo.nameWithOwner)} ${pc.dim(`★ ${repo.stargazerCount}`)}  newcomer-friendliness ${gradeBadge(health)}`);
  p.note(health.signals.map((sg) => `${sg.ok ? icon.pass : icon.warn} ${sg.text}`).join('\n'), 'Repo health');
  if (repo.isArchived) {
    p.log.error('This repository is archived — PRs cannot be opened. Pick another project.');
    return;
  }
  if (health.grade === 'risky') {
    const go = await ask(p.confirm({ message: 'Signals suggest PRs here may sit unreviewed. Continue anyway?', initialValue: false }));
    if (!go) return;
  }

  // 2. Choose an issue that nobody else is already on.
  const issue = await chooseIssue(repo, ref.issue);
  if (!issue) {
    p.outro('No problem — run it again with another repo or issue.');
    return;
  }
  const defaultBranch = repo.defaultBranchRef?.name ?? 'main';

  // 3. Fork + clone (or reuse an existing checkout).
  const { dir, upstreamRemote, pushRemote, forkOwner } = await getCheckout(repo, opts.dir);
  const cwd = dir;

  s.start(`Fetching ${upstreamRemote}/${defaultBranch}`);
  run('git', ['fetch', upstreamRemote, defaultBranch], { cwd, allowFail: true });
  s.stop(`Up to date with ${upstreamRemote}/${defaultBranch}`);

  // 4. Read the rules of the house.
  const guide = findContributingDoc(cwd);
  const subjects = run('git', ['log', '--format=%s', '-n', '60', `${upstreamRemote}/${defaultBranch}`], { cwd, allowFail: true }).stdout.split('\n');
  const conventions = detectConventions(cwd, guide?.text ?? '', subjects);
  const toolchain = detectToolchain(cwd);
  const plan = mergeCommands(guide ? extractCommands(guide.text) : [], toolchain);

  if (guide) {
    const rules = extractRules(guide.text);
    p.note(
      (rules.length ? rules.map((r) => `• ${truncate(r, 160)}`).join('\n') : pc.dim('(no explicit rules found — skim it yourself)')) + `\n\n${pc.dim(`Full guide: ${guide.path}`)}`,
      `Key points from ${guide.path}`,
    );
  } else {
    p.log.warn('No CONTRIBUTING guide. Read the README and a few recently merged PRs to learn the conventions.');
  }
  p.note(expectationLines(conventions, issue).join('\n'), 'What reviewers here will expect');

  // 5. Get the project building locally.
  const installed = {
    node: process.version,
    python: versionOf('python3', ['--version']),
    go: versionOf('go', ['version']),
  };
  for (const w of checkRuntimes(toolchain.runtimes, installed)) p.log.warn(w);
  if (toolchain.ecosystems.length) p.log.info(`Detected: ${toolchain.ecosystems.join(', ')}`);

  const setupResults = {};
  if (plan.setup.length) {
    const chosen = await ask(
      p.multiselect({
        message: 'Run these setup steps? (you can untick any)',
        options: plan.setup.map(({ cmd, source }) => ({ value: cmd, label: cmd, hint: source === 'guide' ? 'from contributing guide' : 'detected' })),
        initialValues: plan.setup.filter((c) => c.default).map((c) => c.cmd),
        required: false,
      }),
    );
    for (const cmd of chosen) setupResults[cmd] = await runStep(cmd, cwd);
  } else {
    p.log.info('No setup steps found — check the README for how to build the project.');
  }
  if (plan.other.length) {
    p.note(plan.other.map((c) => `$ ${c.cmd}`).join('\n'), 'Other commands mentioned in the guide (not run)');
  }

  // Which test/lint commands should `check` run later?
  let verify = [...plan.test, ...plan.lint].filter((c) => c.default).map((c) => c.cmd);
  const all = [...plan.test, ...plan.lint];
  if (all.some((c) => !c.default)) {
    verify = await ask(
      p.multiselect({
        message: 'Which test/lint commands should `check` run before you open a PR?',
        options: all.map(({ cmd, source }) => ({ value: cmd, label: cmd, hint: source === 'guide' ? 'from contributing guide' : 'detected' })),
        initialValues: verify,
        required: false,
      }),
    );
  }
  const testCmds = plan.test.map((c) => c.cmd).filter((c) => verify.includes(c));
  const lintCmds = plan.lint.map((c) => c.cmd).filter((c) => verify.includes(c));

  let baseline = null;
  if (testCmds.length) {
    const runBaseline = await ask(
      p.confirm({
        message: `Run the test suite now as a baseline? ${pc.dim('(so later you know which failures were already there)')}`,
        initialValue: true,
      }),
    );
    if (runBaseline) {
      baseline = {};
      for (const cmd of testCmds) baseline[cmd] = await runStep(cmd, cwd);
    }
  }

  // 6. Topic branch off the latest upstream.
  const suggested = branchNameFor(issue);
  const branch = await ask(
    p.text({ message: 'Branch name', initialValue: suggested, validate: (v) => (/^[\w./-]+$/.test(v) && !v.endsWith('/') ? undefined : 'Letters, numbers, - _ . / only') }),
  );
  const exists = run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd, allowFail: true }).ok;
  if (exists) run('git', ['switch', branch], { cwd });
  else run('git', ['switch', '-c', branch, '--no-track', `${upstreamRemote}/${defaultBranch}`], { cwd });
  p.log.success(`On branch ${pc.cyan(branch)}`);

  // 7. Point them at the code.
  const terms = extractSearchTerms(issue.title, issue.body);
  const files = terms.length ? findRelevantFiles(cwd, terms) : [];
  if (files.length) {
    p.note(files.map((f) => `${pc.cyan(f.file)} ${pc.dim(`(${f.matched.slice(0, 3).join(', ')})`)}`).join('\n'), 'Likely places to start reading');
  }

  const state = {
    version: 1,
    upstream: repo.nameWithOwner,
    upstreamRemote,
    pushRemote,
    forkOwner,
    defaultBranch,
    branch,
    issue: { number: issue.number, title: issue.title, url: issue.url },
    commands: { setup: plan.setup.map((c) => c.cmd), test: testCmds, lint: lintCmds, build: plan.build.map((c) => c.cmd) },
    conventions,
    contributingPath: guide?.path ?? null,
    baseline,
    setupResults,
    startedAt: new Date().toISOString(),
  };
  saveState(state, cwd);

  // 8. Let maintainers know (optional, but avoids duplicate work).
  await maybeClaim(repo, issue, conventions, files);

  const rel = relative(process.cwd(), cwd) || '.';
  p.note(
    [
      `${pc.bold('1.')} cd ${rel}`,
      `${pc.bold('2.')} Reproduce the problem first. If you can, write a failing test.`,
      `${pc.bold('3.')} Make the smallest change that fixes it. Match the surrounding code style.`,
      `${pc.bold('4.')} Commit:  git commit${conventions.dco ? ' -s' : ''} -m "${commitExample(conventions, issue)}"`,
      `${pc.bold('5.')} npx contribution-farmer check   ${pc.dim('← reviewer-style checklist + tests/lint')}`,
      `${pc.bold('6.')} npx contribution-farmer pr      ${pc.dim('← push + pre-filled PR description')}`,
    ].join('\n'),
    'Next steps',
  );
  p.outro(`Good luck with ${pc.cyan(`#${issue.number}`)} 🌱`);
}

function versionOf(cmd, args) {
  const r = run(cmd, args, { allowFail: true });
  if (!r.ok) return null;
  return (r.stdout || r.stderr).match(/\d+\.\d+(\.\d+)?/)?.[0] ?? null;
}

function expectationLines(c, issue) {
  const lines = [];
  const styleName = { conventional: 'Conventional Commits', scoped: '"area: summary" prefixes', freeform: 'plain, descriptive messages' }[c.commitStyle];
  lines.push(`${icon.info} Commit style: ${styleName} ${pc.dim(`(from ${c.commitStyleSource})`)}`);
  lines.push(`   e.g. ${pc.cyan(commitExample(c, issue))}`);
  if (c.dco) lines.push(`${icon.warn} DCO sign-off required: commit with ${pc.cyan('git commit -s')}`);
  if (c.cla) lines.push(`${icon.warn} CLA: a bot will ask you to sign a Contributor License Agreement on your first PR`);
  if (c.changesets) lines.push(`${icon.warn} Changesets: add one with ${pc.cyan('npx changeset')} before opening the PR`);
  if (c.changelog) lines.push(`${icon.warn} Add an entry to the ${c.changelog}`);
  if (c.issueFirst) lines.push(`${icon.warn} Discuss your approach on the issue before writing lots of code`);
  if (c.testsExpected) lines.push(`${icon.warn} Tests are expected with code changes`);
  if (c.prTemplates.length) lines.push(`${icon.info} PR template: ${c.prTemplates[0]} (we'll pre-fill it)`);
  return lines;
}

async function chooseIssue(repo, preselected) {
  const [owner, name] = repo.nameWithOwner.split('/');

  if (preselected) return confirmIssue(fetchIssue(owner, name, preselected));

  const labelNames = repo.labels.nodes.map((l) => l.name);
  let labels = beginnerLabels(labelNames);
  for (;;) {
    const s = p.spinner();
    s.start(labels.length ? `Finding open issues labelled ${labels.map((l) => `"${l}"`).join(', ')}` : 'Fetching open issues');
    const ranked = rankIssues(fetchIssues(owner, name, labels));
    const available = ranked.filter((r) => r.available);
    if (templatedShare(ranked.map((r) => r.issue.title)) > 0.5) {
      p.log.warn('Most of these issues are copies of one template. They’re easy, but a fix to a real bug will teach you (and show) far more.');
    }
    const taken = ranked.length - available.length;
    s.stop(`${available.length} available issue(s)${taken ? pc.dim(` · ${taken} skipped (assigned or already has an open PR)`) : ''}`);

    const options = available.slice(0, 15).map(({ issue, warnings }) => ({
      value: issue.number,
      label: `#${issue.number} ${truncate(issue.title, 70)}`,
      hint: [`💬 ${issue.comments.totalCount}`, `updated ${daysSince(issue.updatedAt)}d ago`, warnings[0] ? `⚠ ${truncate(warnings[0], 50)}` : ''].filter(Boolean).join(' · '),
    }));
    if (labels.length) options.push({ value: 'all', label: pc.dim('Show all open issues instead') });
    options.push({ value: 'manual', label: pc.dim('Enter an issue number') });

    const pick = await ask(p.select({ message: 'Pick an issue', options, maxItems: 10 }));
    if (pick === 'all') {
      labels = [];
      continue;
    }
    const number =
      pick === 'manual'
        ? Number(await ask(p.text({ message: 'Issue number', validate: (v) => (/^\d+$/.test(v.replace('#', '')) ? undefined : 'Just the number, e.g. 123') })).then((v) => v.replace('#', '')))
        : pick;
    const issue = ranked.find((r) => r.issue.number === number)?.issue ?? fetchIssue(owner, name, number);
    const confirmed = await confirmIssue(issue);
    if (confirmed) return confirmed;
  }
}

async function confirmIssue(issue) {
  const { blockers, warnings } = assessIssue(issue);
  const labels = issue.labels.nodes.map((l) => pc.magenta(l.name)).join(' ');
  const lastComments = (issue.comments.nodes ?? [])
    .slice(-3)
    .map((c) => `${pc.dim(`@${c.author?.login ?? 'ghost'} (${c.authorAssociation.toLowerCase()}, ${daysSince(c.createdAt)}d ago):`)} ${truncate(c.body, 140)}`);
  p.note(
    [labels, '', preview(issue.body), ...(lastComments.length ? ['', pc.bold('Latest comments'), ...lastComments] : []), '', pc.dim(issue.url)].join('\n'),
    `#${issue.number} ${truncate(issue.title, 70)}`,
  );
  for (const b of blockers) p.log.error(b);
  for (const w of warnings) p.log.warn(w);

  const go = await ask(
    p.confirm({
      message: blockers.length ? 'Someone may already be on this. Work on it anyway?' : 'Work on this issue?',
      initialValue: blockers.length === 0,
    }),
  );
  return go ? issue : null;
}

async function getCheckout(repo, dirOpt) {
  const full = repo.nameWithOwner;
  const [, name] = full.split('/');
  const canPush = ['ADMIN', 'MAINTAIN', 'WRITE'].includes(repo.viewerPermission);

  let dir = resolve(dirOpt ?? name);
  if (existsSync(dir)) {
    const remotes = run('git', ['remote', '-v'], { cwd: dir, allowFail: true }).stdout;
    if (new RegExp(`[/:]${full.replace('.', '\\.')}(\\.git)?\\s`, 'i').test(remotes)) {
      p.log.info(`Reusing existing checkout at ${dir}`);
      const hasUpstream = /^upstream\s/m.test(remotes);
      if (!canPush && !hasUpstream) run('git', ['remote', 'add', 'upstream', `https://github.com/${full}.git`], { cwd: dir });
      const forkOwner = canPush ? null : run('git', ['remote', 'get-url', 'origin'], { cwd: dir }).match(/github\.com[/:]([^/]+)\//)?.[1];
      return { dir, upstreamRemote: canPush ? 'origin' : 'upstream', pushRemote: 'origin', forkOwner };
    }
    const alt = await ask(p.text({ message: `${dir} already exists. Clone into which folder?`, initialValue: `${name}-contrib` }));
    dir = resolve(alt);
  }

  let cloneFrom = full;
  let forkOwner = null;
  if (!canPush) {
    const s = p.spinner();
    s.start(`Forking ${full} to your account`);
    run('gh', ['repo', 'fork', full, '--clone=false', '--default-branch-only'], { allowFail: true });
    const login = viewerLogin();
    cloneFrom = resolveFork(login, full);
    forkOwner = login;
    s.stop(`Fork ready: ${cloneFrom}`);
  }

  p.log.step(`Cloning ${cloneFrom} → ${dir}`);
  const code = await runLive('gh', ['repo', 'clone', cloneFrom, dir, '--', '--filter=blob:none']);
  if (code !== 0) throw new Error('Clone failed');
  const remotes = run('git', ['remote'], { cwd: dir }).split('\n');
  if (!canPush && !remotes.includes('upstream')) run('git', ['remote', 'add', 'upstream', `https://github.com/${full}.git`], { cwd: dir });
  return { dir, upstreamRemote: canPush ? 'origin' : 'upstream', pushRemote: 'origin', forkOwner };
}

/** Forks can take a few seconds to appear, and may be named differently if the user already had a same-named repo. */
function resolveFork(login, upstream) {
  const [, name] = upstream.split('/');
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = rest(`repos/${login}/${name}`);
      if (r?.fork && r.parent?.full_name?.toLowerCase() === upstream.toLowerCase()) return r.full_name;
    } catch {}
    try {
      const forks = rest(`repos/${upstream}/forks?per_page=100&sort=newest`);
      const mine = forks.find((f) => f.owner.login.toLowerCase() === login.toLowerCase());
      if (mine) return mine.full_name;
    } catch {}
    sleep(2000);
  }
  throw new Error(`Couldn't find your fork of ${upstream}. Try: gh repo fork ${upstream}`);
}

async function maybeClaim(repo, issue, conventions, files) {
  const already = (issue.comments.nodes ?? []).some((c) => c.author?.login && c.author.login === safeLogin());
  if (already) return;
  const recommend = conventions.issueFirst || issue.labels.nodes.some((l) => /needs.?(discussion|triage)/i.test(l.name));
  const want = await ask(
    p.confirm({
      message: `Leave a comment on #${issue.number} saying you're working on it?${recommend ? pc.yellow(' (this project asks you to discuss first)') : ''}`,
      initialValue: recommend,
    }),
  );
  if (!want) return;
  const fileHint = files[0] ? ` I'm planning to start in \`${files[0].file}\`.` : '';
  const body = await ask(
    p.text({
      message: 'Comment (edit it — a sentence on your planned approach makes maintainers far more likely to say yes)',
      initialValue: `Hi! I'd like to work on this.${fileHint} My plan is to ... Does that sound like the right approach?`,
      validate: (v) => (v.includes('...') ? 'Replace the "..." with your actual plan' : undefined),
    }),
  );
  const ok = await ask(p.confirm({ message: `Post this publicly on ${repo.nameWithOwner}#${issue.number}?` }));
  if (!ok) return;
  run('gh', ['issue', 'comment', String(issue.number), '--repo', repo.nameWithOwner, '--body', body]);
  p.log.success('Comment posted. Give maintainers a day or two to respond before investing heavily.');
}

let cachedLogin;
function safeLogin() {
  if (cachedLogin === undefined) {
    try {
      cachedLogin = viewerLogin();
    } catch {
      cachedLogin = null;
    }
  }
  return cachedLogin;
}
