import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOC_DIRS = ['', '.github', 'docs', 'doc'];

/** Locate the contributing guide (CONTRIBUTING.md, .github/CONTRIBUTING.rst, docs/contributing.md, ...). */
export function findContributingDoc(root) {
  for (const dir of DOC_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    let entries;
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    const hit = entries.find((f) => /^contributing(\.(md|markdown|rst|txt|adoc))?$/i.test(f));
    if (hit) {
      const path = join(dir, hit);
      return { path, text: readFileSync(join(root, path), 'utf8') };
    }
  }
  return null;
}

const SHELL_LANGS = new Set(['', 'sh', 'bash', 'shell', 'console', 'zsh', 'shell-session', 'shellsession', 'terminal', 'fish', 'cmd', 'powershell', 'ps1', 'text']);
const CMD_START =
  /^(npm|npx|yarn|pnpm|bun|bunx|node|corepack|pip3?|pipx|python3?|py|poetry|uv|pdm|hatch|tox|nox|pytest|make|just|task|cmake|cargo|rustup|go|bundle|gem|rake|rspec|mvn|\.\/mvnw|gradle|\.\/gradlew|dotnet|composer|php|mix|deno|pre-commit|prek|docker|docker-compose|git submodule|git lfs|\.\/[\w./-]+\.sh|script\/\w+|bin\/\w+)\b/;
// Git plumbing the CLI does for you, or steps that only make sense for the doc's own walkthrough.
const SKIP = /^(git (clone|remote|checkout|switch|push|pull|fetch|commit|add|rebase|merge|branch|config|status|log|diff)|cd |gh repo (fork|clone)|sudo |brew |apt(-get)? |choco |winget |curl |wget )/;
const PLACEHOLDER = /<[^>]+>|your[-_ ]?(user(name)?|fork|github)|\bYOUR_|\{\{|\{\w+\}|https?:\/\//i;

/** Pull runnable shell commands out of fenced code blocks. */
export function extractCommands(markdown) {
  const commands = [];
  const fence = /^[ \t]*(```|~~~)[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)^[ \t]*\1/gm;
  let m;
  while ((m = fence.exec(markdown))) {
    const lang = m[2].toLowerCase();
    if (!SHELL_LANGS.has(lang)) continue;
    const promptOnly = lang === 'console' || lang === 'shell-session' || lang === 'shellsession';
    const joined = m[3].replace(/\s*\\\n\s*/g, ' ');
    for (const raw of joined.split('\n')) {
      let line = raw.trim();
      const hadPrompt = /^[$%]\s/.test(line);
      if (promptOnly && !hadPrompt) continue;
      line = line.replace(/^[$%]\s+/, '').replace(/\s+#\s.*$/, '').trim();
      if (!line || line.startsWith('#')) continue;
      if (SKIP.test(line) || PLACEHOLDER.test(line)) continue;
      if (!CMD_START.test(line)) continue;
      if (!commands.includes(line)) commands.push(line);
    }
  }
  return commands;
}

/** Bucket a command by what it is for. */
export function classifyCommand(cmd) {
  const c = cmd.toLowerCase();
  if (/^(npm|pnpm|yarn|bun) (i|add)\b/.test(c)) return 'setup';
  if (/\b(install|ci|bootstrap|setup|sync|submodule|deps|download|corepack enable|pre-commit install|venv|restore|get)\b/.test(c) && !/\b(test|lint)\b/.test(c)) return 'setup';
  if (/\b(test|tests|pytest|tox|nox|rspec|jest|vitest|mocha|spec|ctest)\b/.test(c)) return 'test';
  if (/\b(lint|check|clippy|vet|ruff|flake8|eslint|pylint|mypy|tsc|typecheck|type-check|fmt|format|prettier|black|isort|rubocop|stylelint|biome)\b/.test(c)) return 'lint';
  if (/\b(build|compile|dist|bundle)\b/.test(c)) return 'build';
  return 'other';
}

const RULE_TOPIC =
  /\b(test|tests|commit|sign[- ]?off|signed-off|dco|cla|issue|changelog|changeset|lint|format|branch|squash|rebase|pull request|pr|discuss|assign|document|docs|review|style|typescript|types?)\b/i;
const RULE_MODAL = /\b(must|required?|please|should|always|never|don't|do not|make sure|ensure|before|avoid)\b/i;

function stripMarkdown(s) {
  return s
    .replace(/^\s*([-*+]|\d+[.)])\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Surface the handful of sentences that read like rules a reviewer will hold you to. */
export function extractRules(markdown, limit = 8) {
  const withoutCode = markdown.replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1/gm, '');
  const candidates = [];
  for (const block of withoutCode.split(/\n(?=\s*(?:[-*+]|\d+[.)])\s)|\n\s*\n/)) {
    const text = stripMarkdown(block.replace(/\n/g, ' '));
    if (text.length < 25 || text.length > 260 || text.startsWith('#') || /^\|/.test(text)) continue;
    let score = 0;
    if (RULE_MODAL.test(text)) score += 2;
    if (RULE_TOPIC.test(text)) score += 1;
    if (/\b(must|required|never|do not|don't)\b/i.test(text)) score += 1;
    if (/:$/.test(text)) score -= 2;
    if (score >= 3) candidates.push({ text, score });
  }
  const seen = new Set();
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((c) => (seen.has(c.text) ? false : seen.add(c.text)))
    .slice(0, limit)
    .map((c) => c.text);
}
