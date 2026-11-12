import { daysSince } from './health.js';

const CLAIM_RE =
  /\b(i('d| would) (like|love) to|can i|could i|may i|i('ll| will)|let me|i want to|i am|i'm)\b.{0,25}\b(work|take|pick|try|tackle|handle|fix|contribute|grab)\b|\bassign (this |it )?(to )?me\b|\bworking on (this|it)\b/i;
const TRIVIAL_RE = /no coding required|no (code|setup) (needed|required)|under (60|sixty) seconds|<\s*1 ?min(ute)?\b|takes? less than a minute/i;
const MAINTAINER = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Inspect an issue for anything that makes it a bad pick right now. */
export function assessIssue(issue, now = Date.now()) {
  const warnings = [];
  const blockers = [];

  if (issue.assignees?.totalCount) {
    blockers.push(`Assigned to ${issue.assignees.nodes.map((a) => '@' + a.login).join(', ')}`);
  }
  if (issue.locked) blockers.push('Issue is locked');

  const openPRs = new Map();
  for (const node of issue.timelineItems?.nodes ?? []) {
    const pr = node?.source ?? node?.subject;
    if (pr?.number && pr.state === 'OPEN') openPRs.set(pr.number, pr);
  }
  for (const pr of openPRs.values()) {
    blockers.push(`Open PR #${pr.number} by @${pr.author?.login ?? 'unknown'} already references it`);
  }

  const recentClaims = (issue.comments?.nodes ?? []).filter(
    (c) => !MAINTAINER.has(c.authorAssociation) && daysSince(c.createdAt, now) <= 45 && CLAIM_RE.test(c.body ?? ''),
  );
  if (recentClaims.length) {
    const c = recentClaims[recentClaims.length - 1];
    warnings.push(`@${c.author?.login ?? 'someone'} asked to work on this ${daysSince(c.createdAt, now)}d ago`);
  }

  if (TRIVIAL_RE.test(issue.body ?? '')) {
    warnings.push('Templated busy-work issue — fine for practising the PR flow, but it won’t show much to anyone reviewing your work');
  }

  const age = daysSince(issue.createdAt, now);
  if (age > 365) warnings.push(`Opened ${Math.round(age / 365)}y ago — check it's still relevant`);
  if ((issue.body ?? '').trim().length < 80) warnings.push('Very short description — you may need to ask clarifying questions');
  if ((issue.comments?.totalCount ?? 0) > 15) warnings.push('Long discussion — read it all before starting');

  return { blockers, warnings, available: blockers.length === 0 };
}

/** Sort available issues first, then ones without warnings, then most recently active. */
export function rankIssues(issues, now = Date.now()) {
  return issues
    .map((issue) => ({ issue, ...assessIssue(issue, now) }))
    .sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      if (a.warnings.length !== b.warnings.length) return a.warnings.length - b.warnings.length;
      return new Date(b.issue.updatedAt) - new Date(a.issue.updatedAt);
    });
}

export function branchNameFor(issue) {
  const labels = (issue.labels?.nodes ?? []).map((l) => l.name.toLowerCase());
  const prefix = labels.some((l) => /doc/.test(l))
    ? 'docs'
    : labels.some((l) => /feature|enhancement/.test(l))
      ? 'feat'
      : labels.some((l) => /test/.test(l))
        ? 'test'
        : 'fix';
  const slug = issue.title
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-');
  return `${prefix}/${issue.number}-${slug || 'issue'}`;
}

/**
 * Share of issues that look mass-produced from one template (same opening words).
 * Repos that churn out hundreds of "add one line to a JSON file" issues are farming contributions, not welcoming them.
 */
export function templatedShare(titles) {
  if (titles.length < 4) return 0;
  const key = (t) => t.toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  const counts = new Map();
  for (const t of titles) counts.set(key(t), (counts.get(key(t)) ?? 0) + 1);
  return Math.max(...counts.values()) / titles.length;
}
