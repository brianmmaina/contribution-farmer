import { run } from '../exec.js';
import { CONVENTIONAL_RE, SCOPED_RE } from './conventions.js';

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)\.[a-z]+$|_test\.(go|py|rb|exs?)$|^test_.*\.py$|\/test_[^/]*\.py$/i;
const DOC_FILE = /\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//i;
const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/;
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile|composer\.json|requirements[\w-]*\.txt)$/;
const DEBUG_LEFTOVERS = [
  { re: /\bconsole\.(log|debug)\(/, label: 'console.log' },
  { re: /^\s*debugger;?\s*$/, label: 'debugger statement' },
  { re: /\b(pdb|ipdb)\.set_trace\(|^\s*breakpoint\(\)/, label: 'Python breakpoint' },
  { re: /\bdbg!\(/, label: 'dbg! macro' },
  { re: /\bbinding\.(pry|irb)\b/, label: 'binding.pry' },
  { re: /\bfmt\.Print(ln|f)?\(\s*"(debug|here|xxx)/i, label: 'debug print' },
];
const VAGUE_SUBJECT = /^(fix(es|ed)?|update[sd]?|changes?|wip|tmp|test|stuff|misc|minor|cleanup|refactor|asdf|\.)\s*\.?$/i;

/** Collect what we need from git to judge a branch against upstream. */
export function gatherBranchFacts(root, { upstreamRef }) {
  const g = (args) => run('git', args, { cwd: root, allowFail: true });
  const branch = g(['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
  const dirty = g(['status', '--porcelain']).stdout.split('\n').filter(Boolean);
  const counts = g(['rev-list', '--left-right', '--count', `${upstreamRef}...HEAD`]).stdout.split(/\s+/).map(Number);
  const [behind = 0, ahead = 0] = counts;

  const log = g(['log', '--no-merges', '--format=%s%x1f%b%x1f%an%x1e', `${upstreamRef}..HEAD`]).stdout;
  const commits = log
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [subject, body = '', author = ''] = entry.split('\x1f');
      return { subject, body, author };
    });

  const files = g(['diff', '--numstat', `${upstreamRef}...HEAD`])
    .stdout.split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a, r, ...p] = l.split('\t');
      return { path: p.join('\t'), added: a === '-' ? 0 : Number(a), removed: r === '-' ? 0 : Number(r), binary: a === '-' };
    });

  const addedLines = [];
  let current = null;
  for (const line of g(['diff', '-U0', `${upstreamRef}...HEAD`]).stdout.split('\n')) {
    if (line.startsWith('+++ ')) current = line.slice(6);
    else if (line.startsWith('+') && !line.startsWith('+++') && current) addedLines.push({ file: current, text: line.slice(1) });
  }

  const whitespaceOnly = [];
  for (const f of files) {
    if (f.binary) continue;
    const ignoringWs = g(['diff', '-w', '--numstat', `${upstreamRef}...HEAD`, '--', f.path]).stdout;
    if (!ignoringWs.trim()) whitespaceOnly.push(f.path);
  }

  return { branch, dirty, ahead, behind, commits, files, addedLines, whitespaceOnly };
}

/**
 * Turn branch facts into a reviewer-style checklist.
 * Each item: { level: 'pass' | 'warn' | 'fail', title, detail? }
 */
export function evaluate(facts, ctx) {
  const items = [];
  const pass = (title, detail) => items.push({ level: 'pass', title, detail });
  const warn = (title, detail) => items.push({ level: 'warn', title, detail });
  const fail = (title, detail) => items.push({ level: 'fail', title, detail });
  const { conventions = {}, defaultBranch = 'main', issueNumber } = ctx;

  if (facts.branch === defaultBranch) fail(`You're on ${defaultBranch}`, 'Work on a topic branch so your fork’s default branch stays clean.');
  else pass(`On topic branch ${facts.branch}`);

  if (facts.dirty.length) warn(`${facts.dirty.length} uncommitted change(s)`, 'Commit or stash them — only committed work ends up in the PR.');

  if (facts.ahead === 0) {
    fail('No commits yet', 'Commit your change, then run this again.');
    return items;
  }
  pass(`${facts.ahead} commit(s) ahead of upstream`);

  if (facts.behind > 0) warn(`${facts.behind} commit(s) behind upstream/${defaultBranch}`, `Rebase so reviewers test against current code: git fetch upstream && git rebase upstream/${defaultBranch}`);
  else pass('Up to date with upstream');

  // Commit hygiene
  const subjects = facts.commits.map((c) => c.subject);
  if (conventions.commitStyle === 'conventional') {
    const bad = subjects.filter((s) => !CONVENTIONAL_RE.test(s));
    if (bad.length) fail('Commit messages don’t follow Conventional Commits', `e.g. "fix(parser): handle empty input". Offending: ${bad.map((s) => `"${s}"`).join(', ')}`);
    else pass('Commit messages follow Conventional Commits');
  } else if (conventions.commitStyle === 'scoped') {
    const bad = subjects.filter((s) => !SCOPED_RE.test(s));
    if (bad.length) warn('This project prefixes commits with the area they touch', `e.g. "cli: handle empty input". Offending: ${bad.map((s) => `"${s}"`).join(', ')}`);
  }
  const vague = subjects.filter((s) => VAGUE_SUBJECT.test(s.replace(CONVENTIONAL_RE, '').trim()) || s.replace(/^[\w()!-]+: /, '').length < 8);
  if (vague.length) warn('Vague commit message(s)', `Say what changed and why: ${vague.map((s) => `"${s}"`).join(', ')}`);
  const long = subjects.filter((s) => s.length > 72);
  if (long.length) warn('Commit subject over 72 characters', 'Keep the first line short; put detail in the body.');
  if (facts.commits.length > 5) warn(`${facts.commits.length} commits`, 'Consider squashing fix-ups (git rebase -i) so history tells a clear story — unless maintainers squash on merge.');

  if (conventions.dco) {
    const unsigned = facts.commits.filter((c) => !/^Signed-off-by: .+<.+>/m.test(c.body));
    if (unsigned.length) fail(`${unsigned.length} commit(s) missing DCO sign-off`, `This project requires "Signed-off-by". Fix: git rebase --signoff upstream/${defaultBranch}`);
    else pass('All commits are signed off (DCO)');
  }

  // Diff shape
  const total = facts.files.reduce((n, f) => n + f.added + f.removed, 0);
  const codeFiles = facts.files.filter((f) => !DOC_FILE.test(f.path) && !TEST_FILE.test(f.path) && !LOCKFILE.test(f.path));
  const testFiles = facts.files.filter((f) => TEST_FILE.test(f.path));
  if (total > 500) warn(`Large diff: ${total} lines across ${facts.files.length} files`, 'First PRs land faster when small. Can this be split?');
  else pass(`Focused diff: ${total} lines across ${facts.files.length} file(s)`);

  if (facts.whitespaceOnly?.length) warn('Whitespace-only changes', `Revert formatting noise in: ${facts.whitespaceOnly.join(', ')}`);

  const lockChanged = facts.files.some((f) => LOCKFILE.test(f.path));
  const manifestChanged = facts.files.some((f) => MANIFEST.test(f.path));
  if (lockChanged && !manifestChanged) warn('Lockfile changed without a dependency change', 'Usually an accident from a different package-manager version. Restore it: git checkout upstream/' + defaultBranch + ' -- <lockfile>');

  if (codeFiles.length && !testFiles.length) {
    (conventions.testsExpected ? fail : warn)('Code changed but no tests added or updated', 'A test that fails before your fix and passes after is the strongest evidence a reviewer can get.');
  } else if (testFiles.length) pass(`Tests touched (${testFiles.length} file(s))`);

  const leftovers = [];
  for (const { file, text } of facts.addedLines) {
    if (TEST_FILE.test(file)) continue;
    for (const d of DEBUG_LEFTOVERS) if (d.re.test(text)) leftovers.push(`${d.label} in ${file}`);
  }
  if (leftovers.length) warn('Possible debug leftovers', [...new Set(leftovers)].slice(0, 6).join('; '));
  const todos = facts.addedLines.filter((l) => /\b(TODO|FIXME|XXX)\b/.test(l.text)).length;
  if (todos) warn(`${todos} new TODO/FIXME comment(s)`, 'Resolve them or explain them in the PR description.');

  if (conventions.changesets && !facts.files.some((f) => /^\.changeset\/.+\.md$/.test(f.path))) {
    fail('No changeset added', 'This repo uses Changesets. Run: npx changeset');
  }
  if (conventions.changelog && !facts.files.some((f) => /CHANGE(LOG|S)/i.test(f.path))) {
    warn('CHANGELOG not updated', 'The contributing guide asks for a changelog entry.');
  }

  if (issueNumber) {
    const mentioned = facts.commits.some((c) => new RegExp(`#${issueNumber}\\b`).test(`${c.subject}\n${c.body}`));
    if (!mentioned) items.push({ level: 'info', title: `Issue #${issueNumber} will be linked from the PR description` });
  }
  return items;
}

export function summarize(items) {
  return {
    fail: items.filter((i) => i.level === 'fail').length,
    warn: items.filter((i) => i.level === 'warn').length,
    pass: items.filter((i) => i.level === 'pass').length,
  };
}
