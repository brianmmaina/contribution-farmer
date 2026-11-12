import { searchBeginnerIssues, searchRepos, fetchRepos } from '../github.js';
import { scoreRepo, daysSince } from '../lib/health.js';
import { templatedShare } from '../lib/issues.js';
import { buildRepoQuery, SIZES } from '../lib/search.js';
import { ask, p, pc, truncate } from '../ui.js';

const LANGUAGES = ['JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Java', 'Ruby', 'C#', 'C++', 'PHP', 'Kotlin', 'Swift'];
const MIN_SCORE = 4;

/**
 * Find a repo worth contributing to: one with open beginner issues *and* maintainers who merge outside PRs.
 * Returns { owner, name } or null.
 */
export async function find({ language, topic, size, mode } = {}) {
  if (!mode) {
    mode = await ask(
      p.select({
        message: 'How do you want to search?',
        options: [
          { value: 'repos', label: 'Browse projects', hint: 'search all public repos by language, topic and size' },
          { value: 'issues', label: 'Browse beginner issues', hint: 'start from issues, then see which repos they belong to' },
        ],
      }),
    );
  }
  if (language === undefined) {
    language = await ask(
      p.select({
        message: 'Which language do you want to work in?',
        options: [...LANGUAGES.map((l) => ({ value: l, label: l })), { value: '', label: 'Any language' }],
      }),
    );
  }
  if (topic === undefined) {
    topic = await ask(
      p.text({
        message: 'Any topic you care about? (optional)',
        placeholder: 'e.g. cli, testing, react, data, games — or leave blank',
        defaultValue: '',
      }),
    );
  }
  return mode === 'issues' ? findByIssues({ language, topic }) : findByRepos({ language, topic, size });
}

/** Repo-first: GitHub repository search over every public repo, filtered to active projects with beginner issues. */
async function findByRepos({ language, topic, size }) {
  if (!size) {
    size = await ask(
      p.select({
        message: 'What size of project?',
        options: Object.entries(SIZES).map(([value, s]) => ({ value, label: s.label, hint: s.hint })),
        initialValue: 'small',
      }),
    );
  }

  const q = buildRepoQuery({ language, topic, size });
  const shown = [];
  let page = 1;
  let total = 0;
  let exhausted = false;
  let firstNew = 0;

  for (;;) {
    if (!exhausted) {
      const s = p.spinner();
      s.start(page === 1 ? 'Searching all public repos on GitHub' : `Loading page ${page}`);
      firstNew = shown.length;
      const res = searchRepos(q, { page });
      total = res.total;
      exhausted = res.items.length < 30 || page * 30 >= Math.min(total, 1000);
      const refs = res.items.map((it) => ({ owner: it.owner.login, name: it.name, full: it.full_name, search: it }));
      s.message(`Checking how welcoming ${refs.length} repos are`);
      const repos = fetchRepos(refs);
      const scored = refs
        .map((r, i) => ({ ...r, repo: repos[i] }))
        .filter((c) => c.repo && !c.repo.isArchived)
        .map((c) => ({ ...c, health: scoreRepo(c.repo) }))
        .filter((c) => c.health.score >= MIN_SCORE)
        .sort((a, b) => b.health.score - a.health.score || b.repo.stargazerCount - a.repo.stargazerCount);
      shown.push(...scored);
      s.stop(`${total.toLocaleString()} matching repos on GitHub · showing the ${shown.length} most welcoming so far`);
      page++;
    }

    if (!shown.length) {
      p.log.warn(exhausted ? 'Nothing matched. Try "Any size", another language, or a blank topic.' : 'No welcoming repos on this page.');
      if (exhausted) return null;
    }

    const options = shown.map((c) => ({
      value: c,
      label: `${c.full} ${pc.dim(`★ ${c.repo.stargazerCount.toLocaleString()}`)} ${gradeBadge(c.health)}`,
      hint: `${c.repo.primaryLanguage?.name ?? '—'} · pushed ${daysSince(c.repo.pushedAt)}d ago · ${truncate(c.repo.description, 55)}`,
    }));
    if (!exhausted) options.push({ value: 'more', label: pc.dim('Load more results…') });
    const choice = await ask(p.select({ message: 'Pick a project', maxItems: 10, options, initialValue: shown[firstNew] ?? shown[0] }));
    if (choice === 'more') continue;
    return { owner: choice.owner, name: choice.name };
  }
}

/** Issue-first: search open, unassigned beginner issues and group them by repo. */
async function findByIssues({ language, topic }) {
  const s = p.spinner();
  s.start('Searching GitHub for open, unassigned beginner issues');
  let items = searchBeginnerIssues({ language, topic });
  if (items.length < 10) items = items.concat(searchBeginnerIssues({ language, topic, label: 'help wanted' }));

  const byRepo = new Map();
  for (const it of items) {
    const full = it.repository_url.split('/repos/')[1];
    if (!byRepo.has(full)) byRepo.set(full, []);
    byRepo.get(full).push(it);
  }
  const candidates = [...byRepo.keys()].slice(0, 30).map((full) => {
    const [owner, name] = full.split('/');
    return { owner, name, full };
  });

  s.message(`Checking how welcoming ${candidates.length} repos are`);
  const repos = fetchRepos(candidates);
  const ranked = candidates
    .map((c, i) => ({ ...c, repo: repos[i], issues: byRepo.get(c.full) }))
    .filter((c) => c.repo && !c.repo.isArchived && c.repo.stargazerCount >= 50)
    .map((c) => {
      const health = scoreRepo(c.repo);
      if (templatedShare(c.issues.map((i) => i.title)) > 0.5) {
        health.score = Math.max(0, health.score - 5);
        health.signals.push({ ok: false, text: 'Most beginner issues are copies of one template (issue mill)' });
      }
      return { ...c, health };
    })
    .filter((c) => c.health.score >= MIN_SCORE)
    .sort((a, b) => b.health.score - a.health.score || b.repo.stargazerCount - a.repo.stargazerCount)
    .slice(0, 15);
  s.stop(`Found ${ranked.length} repos with active maintainers and open beginner issues`);

  if (!ranked.length) {
    p.log.warn('Nothing good came back. Try a different language, leave the topic blank, or browse projects instead.');
    return null;
  }

  const choice = await ask(
    p.select({
      message: 'Pick a repo',
      maxItems: 10,
      options: ranked.map((c) => ({
        value: c,
        label: `${c.full} ${pc.dim(`★ ${c.repo.stargazerCount.toLocaleString()}`)} ${gradeBadge(c.health)}`,
        hint: `${c.issues.length} open beginner issue(s) · ${truncate(c.repo.description, 55)}`,
      })),
    }),
  );
  return { owner: choice.owner, name: choice.name };
}

export function gradeBadge(health) {
  const label = `${health.score}/10`;
  return health.grade === 'great' ? pc.green(label) : health.grade === 'ok' ? pc.yellow(label) : pc.red(label);
}
