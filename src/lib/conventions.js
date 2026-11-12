import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const CONVENTIONAL_RE = /^(feat|fix|docs|style|refactor|perf|test|tests|build|ci|chore|revert|deps|security)(\([^)]+\))?!?: \S/i;
export const SCOPED_RE = /^[\w./@-]+(, ?[\w./@-]+)*: \S/; // e.g. "net/http: fix ..." (Go, Linux, many C projects)

/** Look at recent upstream commit subjects and infer the house style. */
export function detectCommitStyle(subjects) {
  const relevant = subjects.filter((s) => s && !/^Merge\b/.test(s));
  if (relevant.length < 5) return { style: 'freeform', confidence: 0, examples: relevant.slice(0, 3) };
  const conventional = relevant.filter((s) => CONVENTIONAL_RE.test(s));
  const scoped = relevant.filter((s) => !CONVENTIONAL_RE.test(s) && SCOPED_RE.test(s));
  const ratioC = conventional.length / relevant.length;
  const ratioS = scoped.length / relevant.length;
  if (ratioC >= 0.6) return { style: 'conventional', confidence: ratioC, examples: conventional.slice(0, 3) };
  if (ratioS >= 0.6) return { style: 'scoped', confidence: ratioS, examples: scoped.slice(0, 3) };
  return { style: 'freeform', confidence: 1 - Math.max(ratioC, ratioS), examples: relevant.slice(0, 3) };
}

function findPRTemplates(root) {
  const found = [];
  for (const dir of ['.github', '', 'docs']) {
    let entries = [];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && /^pull_request_template\.md$/i.test(e.name)) found.push(join(dir, e.name));
      if (e.isDirectory() && /^pull_request_template$/i.test(e.name)) {
        for (const f of readdirSync(join(root, dir, e.name))) if (f.endsWith('.md')) found.push(join(dir, e.name, f));
      }
    }
  }
  return found;
}

/** Everything a reviewer will expect that isn't the code itself. */
export function detectConventions(root, contributingText = '', commitSubjects = []) {
  const doc = contributingText;
  const exists = (f) => existsSync(join(root, f));
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {}

  const commitlint =
    ['commitlint.config.js', 'commitlint.config.cjs', 'commitlint.config.mjs', 'commitlint.config.ts', '.commitlintrc', '.commitlintrc.json', '.commitlintrc.yml', '.commitlintrc.js'].some(exists) ||
    Boolean(pkg.commitlint);
  const history = detectCommitStyle(commitSubjects);
  const docSaysConventional = /conventional[ -]?commits?|commitlint|semantic commit/i.test(doc);
  const commitStyle = commitlint || docSaysConventional ? 'conventional' : history.style;

  return {
    commitStyle,
    commitStyleSource: commitlint ? 'commitlint config' : docSaysConventional ? 'contributing guide' : `last ${commitSubjects.length} commits`,
    commitExamples: history.examples,
    dco: /\bDCO\b|Developer Certificate of Origin|Signed-off-by|\bsign[- ]off\b|git commit -s\b/i.test(doc) || exists('.github/dco.yml'),
    cla: /\bCLA\b|Contributor License Agreement/i.test(doc),
    changesets: exists('.changeset/config.json'),
    changelog: /update (the )?CHANGELOG|add (an? )?(entry|line) to (the )?CHANGELOG|CHANGES\.(md|rst)/i.test(doc) ? 'CHANGELOG' : null,
    issueFirst: /(open|create|file|start with) an issue (first|before)|discuss(ed)? .{0,40}before (you |submitting|opening|starting)|get (an? )?(approval|agreement|go-ahead)/i.test(doc),
    testsExpected: /(add|include|write|update)\s.{0,20}tests?\b|tests? (are|is) required|with tests/i.test(doc),
    prTemplates: findPRTemplates(root),
  };
}

export function commitExample(conventions, issue) {
  const summary = (issue?.title || 'describe the change').replace(/\.$/, '');
  const lower = summary.charAt(0).toLowerCase() + summary.slice(1);
  if (conventions.commitStyle === 'conventional') return `fix: ${lower}`;
  if (conventions.commitStyle === 'scoped') return `<area>: ${lower}`;
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}
