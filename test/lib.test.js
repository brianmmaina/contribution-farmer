import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCommands, classifyCommand, extractRules } from '../src/lib/contributing.js';
import { detectCommitStyle } from '../src/lib/conventions.js';
import { evaluate, summarize } from '../src/lib/checks.js';
import { assessIssue, branchNameFor } from '../src/lib/issues.js';
import { scoreRepo, beginnerLabels } from '../src/lib/health.js';
import { buildPRBody, suggestTitle } from '../src/lib/prbody.js';
import { extractSearchTerms } from '../src/lib/hints.js';
import { mergeCommands, checkRuntimes } from '../src/lib/toolchain.js';
import { parseRepoRef } from '../src/github.js';

const NOW = new Date('2026-11-11T00:00:00Z').getTime();
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

test('parseRepoRef handles short form, URLs and issue URLs', () => {
  assert.deepEqual(parseRepoRef('vercel/next.js'), { owner: 'vercel', name: 'next.js', issue: undefined });
  assert.deepEqual(parseRepoRef('https://github.com/a/b.git'), { owner: 'a', name: 'b', issue: undefined });
  assert.deepEqual(parseRepoRef('https://github.com/a/b/issues/42'), { owner: 'a', name: 'b', issue: 42 });
  assert.equal(parseRepoRef('not a repo'), null);
});

test('extractCommands pulls setup commands and skips git plumbing / placeholders', () => {
  const md = [
    '```bash',
    'git clone https://github.com/<your-username>/proj',
    'cd proj',
    'pnpm install',
    '$ pnpm test',
    '# a comment',
    'npm run lint \\',
    '  -- --fix',
    '```',
    '```console',
    '$ make setup',
    'output line',
    '```',
    '```js',
    'npm install should-not-count',
    '```',
  ].join('\n');
  assert.deepEqual(extractCommands(md), ['pnpm install', 'pnpm test', 'npm run lint -- --fix', 'make setup']);
});

test('classifyCommand buckets commands', () => {
  assert.equal(classifyCommand('npm ci'), 'setup');
  assert.equal(classifyCommand('uv sync'), 'setup');
  assert.equal(classifyCommand('pnpm test'), 'test');
  assert.equal(classifyCommand('cargo clippy'), 'lint');
  assert.equal(classifyCommand('npm run build'), 'build');
});

test('extractRules favours imperative, topical sentences', () => {
  const md = `# Contributing\n\nThanks for being here!\n\n- You must sign off every commit (DCO).\n- Please add tests for any bug fix.\n- We like cats.\n`;
  const rules = extractRules(md);
  assert.ok(rules.some((r) => r.includes('sign off')));
  assert.ok(rules.some((r) => r.includes('add tests')));
  assert.ok(!rules.some((r) => r.includes('cats')));
});

test('detectCommitStyle recognises conventional and scoped histories', () => {
  const conv = ['feat: a', 'fix(core): b', 'docs: c', 'chore: d', 'fix: e', 'Merge pull request #1'];
  assert.equal(detectCommitStyle(conv).style, 'conventional');
  const scoped = ['net/http: fix x', 'cmd/go: add y', 'runtime: z', 'os: w', 'fmt: q'];
  assert.equal(detectCommitStyle(scoped).style, 'scoped');
  assert.equal(detectCommitStyle(['Fix thing', 'Add other', 'Bump', 'Tweak', 'More']).style, 'freeform');
});

const baseFacts = {
  branch: 'fix/1-thing',
  dirty: [],
  ahead: 1,
  behind: 0,
  commits: [{ subject: 'fix(parser): handle empty input', body: 'Signed-off-by: A <a@b.c>' }],
  files: [
    { path: 'src/parser.js', added: 10, removed: 2 },
    { path: 'test/parser.test.js', added: 15, removed: 0 },
  ],
  addedLines: [{ file: 'src/parser.js', text: 'if (!input) return [];' }],
  whitespaceOnly: [],
};

test('evaluate passes a clean, tested, signed-off branch', () => {
  const items = evaluate(baseFacts, { conventions: { commitStyle: 'conventional', dco: true }, defaultBranch: 'main' });
  assert.equal(summarize(items).fail, 0);
  assert.equal(summarize(items).warn, 0);
});

test('evaluate flags the common first-PR mistakes', () => {
  const facts = {
    ...baseFacts,
    branch: 'main',
    behind: 3,
    commits: [{ subject: 'fix', body: '' }],
    files: [
      { path: 'src/parser.js', added: 10, removed: 2 },
      { path: 'package-lock.json', added: 400, removed: 300 },
    ],
    addedLines: [{ file: 'src/parser.js', text: '  console.log(x)' }],
  };
  const items = evaluate(facts, { conventions: { commitStyle: 'conventional', dco: true, changesets: true, testsExpected: true }, defaultBranch: 'main' });
  const titles = items.map((i) => `${i.level}:${i.title}`).join('\n');
  assert.match(titles, /fail:You're on main/);
  assert.match(titles, /warn:3 commit\(s\) behind/);
  assert.match(titles, /fail:Commit messages don’t follow Conventional Commits/);
  assert.match(titles, /fail:1 commit\(s\) missing DCO sign-off/);
  assert.match(titles, /warn:Lockfile changed without a dependency change/);
  assert.match(titles, /fail:Code changed but no tests/);
  assert.match(titles, /warn:Possible debug leftovers/);
  assert.match(titles, /fail:No changeset added/);
  assert.match(titles, /warn:Large diff/);
});

test('evaluate stops early with no commits', () => {
  const items = evaluate({ ...baseFacts, ahead: 0, commits: [], files: [] }, { conventions: {}, defaultBranch: 'main' });
  assert.equal(items.at(-1).title, 'No commits yet');
});

test('assessIssue blocks assigned issues and ones with open PRs, warns on recent claims', () => {
  const issue = {
    createdAt: daysAgo(10),
    body: 'x'.repeat(200),
    assignees: { totalCount: 0, nodes: [] },
    comments: { totalCount: 1, nodes: [{ author: { login: 'eager' }, authorAssociation: 'NONE', body: "Hi, I'd like to work on this!", createdAt: daysAgo(3) }] },
    timelineItems: { nodes: [{ source: { number: 9, state: 'OPEN', author: { login: 'other' } } }, { source: { number: 8, state: 'CLOSED' } }] },
  };
  const r = assessIssue(issue, NOW);
  assert.equal(r.available, false);
  assert.match(r.blockers[0], /Open PR #9/);
  assert.match(r.warnings[0], /@eager asked to work on this 3d ago/);
});

test('branchNameFor uses label-based prefixes and a short slug', () => {
  assert.equal(branchNameFor({ number: 12, title: 'Typo in `README` install section!', labels: { nodes: [{ name: 'documentation' }] } }), 'docs/12-typo-in-readme-install-section');
  assert.equal(branchNameFor({ number: 3, title: 'Crash on empty input', labels: { nodes: [] } }), 'fix/3-crash-on-empty-input');
});

test('scoreRepo rewards activity and outside merges', () => {
  const merged = Array.from({ length: 10 }, (_, i) => ({ mergedAt: daysAgo(i), authorAssociation: i % 2 ? 'CONTRIBUTOR' : 'MEMBER' }));
  const good = scoreRepo({ pushedAt: daysAgo(1), recentMerged: { nodes: merged }, contributingGuidelines: { resourcePath: 'CONTRIBUTING.md' }, codeOfConduct: {}, licenseInfo: { spdxId: 'MIT' } }, NOW);
  assert.equal(good.grade, 'great');
  const dead = scoreRepo({ pushedAt: daysAgo(400), recentMerged: { nodes: [] }, licenseInfo: null }, NOW);
  assert.equal(dead.grade, 'risky');
  assert.equal(scoreRepo({ isArchived: true }).score, 0);
});

test('beginnerLabels prefers explicit beginner labels over help wanted', () => {
  assert.deepEqual(beginnerLabels(['bug', 'good first issue', 'help wanted']), ['good first issue']);
  assert.deepEqual(beginnerLabels(['bug', 'help wanted']), ['help wanted']);
});

test('buildPRBody fills issue placeholders in templates', () => {
  const t = '## Description\n\nFixes # (issue)\n\n- [ ] Tests added';
  const body = buildPRBody({ template: t, issueNumber: 77 });
  assert.match(body, /Fixes #77/);
  assert.match(body, /- \[ \] Tests added/);
  const noRef = buildPRBody({ template: '## Summary\n', issueNumber: 5 });
  assert.match(noRef, /^Closes #5/);
  const generated = buildPRBody({ issueNumber: 5, tested: ['npm test'] });
  assert.match(generated, /`npm test` passes/);
});

test('suggestTitle follows conventional style when needed', () => {
  assert.equal(suggestTitle({ commits: [{ subject: 'fix: x' }] }), 'fix: x');
  assert.equal(suggestTitle({ commits: [{}, {}], issue: { title: 'Crash on start' }, commitStyle: 'conventional' }), 'fix: crash on start');
});

test('extractSearchTerms finds code spans, paths and identifiers', () => {
  const terms = extractSearchTerms('`parseConfig` crashes', 'When calling src/config/loader.ts with --strict-mode the `max_retries` value is ignored').map((t) => t.term);
  assert.ok(terms.includes('parseConfig'));
  assert.ok(terms.includes('src/config/loader.ts'));
  assert.ok(terms.includes('max_retries'));
  assert.ok(terms.includes('--strict-mode'));
});

test('mergeCommands prefers the guide and dedupes', () => {
  const plan = mergeCommands(['pnpm install', 'pnpm test'], { setup: ['pnpm install', 'pre-commit install'], test: ['make test'], lint: ['pnpm run lint'], build: [] });
  assert.deepEqual(plan.setup.map((c) => c.cmd), ['pnpm install', 'pre-commit install']);
  assert.deepEqual(plan.test.map((c) => [c.cmd, c.default]), [['pnpm test', true], ['make test', false]]);
  assert.deepEqual(plan.lint.map((c) => c.cmd), ['pnpm run lint']);
});

test('checkRuntimes warns on old or mismatched versions', () => {
  const w = checkRuntimes(
    [
      { name: 'node', required: '>=20', file: 'package.json engines' },
      { name: 'python', required: '3.12', file: '.python-version' },
    ],
    { node: 'v18.19.0', python: '3.12.1' },
  );
  assert.equal(w.length, 1);
  assert.match(w[0], /node >=20/);
});

test('niche guide commands do not displace the standard test command', () => {
  const plan = mergeCommands(['tox r -e stress'], { setup: [], test: ['uv run pytest'], lint: [], build: [] });
  assert.deepEqual(plan.test.map((c) => [c.cmd, c.default]), [['tox r -e stress', false], ['uv run pytest', true]]);
});

test('buildPRBody adds a visible link when the template only references the issue inside a comment', () => {
  const body = buildPRBody({ template: '<!--\nfixes #\n-->\n## Summary', issueNumber: 9 });
  assert.match(body, /^Closes #9/);
});

test('templatedShare spots issue mills', async () => {
  const { templatedShare } = await import('../src/lib/issues.js');
  const mill = Array.from({ length: 8 }, (_, i) => `[good first issue] 🍣 Add new Grammar Point ${i}`);
  assert.ok(templatedShare(mill) > 0.9);
  assert.ok(templatedShare(['Crash on start', 'Docs typo in README', 'Support Windows paths', 'Flaky test in CI']) <= 0.25);
});

test('buildRepoQuery searches every public repo with beginner issues and recent activity', async () => {
  const { buildRepoQuery } = await import('../src/lib/search.js');
  const q = buildRepoQuery({ language: 'Python', topic: 'cli', size: 'small', now: NOW });
  assert.match(q, /^cli in:name,description,topics /);
  assert.match(q, /good-first-issues:>=3/);
  assert.match(q, /stars:50\.\.1000/);
  assert.match(q, /pushed:>=2026-10-12/);
  assert.match(q, /language:"Python"/);
  assert.doesNotMatch(buildRepoQuery({ now: NOW }), /language:|in:name/);
});
