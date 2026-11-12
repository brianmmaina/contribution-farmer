const DAY = 24 * 60 * 60 * 1000;
const OUTSIDE = new Set(['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE']);

export function daysSince(iso, now = Date.now()) {
  return Math.floor((now - new Date(iso).getTime()) / DAY);
}

/**
 * Score how welcoming/alive a repo is for a newcomer, 0–10.
 * The single most useful signal: do maintainers actually merge PRs from people outside the core team?
 */
export function scoreRepo(repo, now = Date.now()) {
  const signals = [];
  let score = 0;

  if (repo.isArchived) {
    return { score: 0, grade: 'dead', signals: [{ ok: false, text: 'Repository is archived (read-only)' }] };
  }

  const pushedDays = daysSince(repo.pushedAt, now);
  if (pushedDays <= 14) {
    score += 2;
    signals.push({ ok: true, text: `Active: last push ${pushedDays}d ago` });
  } else if (pushedDays <= 60) {
    score += 1;
    signals.push({ ok: true, text: `Last push ${pushedDays}d ago` });
  } else {
    signals.push({ ok: false, text: `Quiet: last push ${pushedDays}d ago` });
  }

  const merged = repo.recentMerged?.nodes ?? [];
  const outside = merged.filter((pr) => OUTSIDE.has(pr.authorAssociation)).length;
  const mergedLast30 = merged.filter((pr) => daysSince(pr.mergedAt, now) <= 30).length;
  if (outside >= 5) score += 3;
  else if (outside >= 2) score += 2;
  else if (outside >= 1) score += 1;
  signals.push({
    ok: outside >= 2,
    text: `${outside} of the last ${merged.length} merged PRs came from outside contributors`,
  });
  if (mergedLast30 >= 3) {
    score += 2;
    signals.push({ ok: true, text: `${mergedLast30} PRs merged in the last 30 days` });
  } else if (mergedLast30 >= 1) {
    score += 1;
    signals.push({ ok: true, text: `${mergedLast30} PR(s) merged in the last 30 days` });
  } else {
    signals.push({ ok: false, text: 'No PRs merged in the last 30 days — reviews may be slow' });
  }

  if (repo.contributingGuidelines) {
    score += 1;
    signals.push({ ok: true, text: `Has a contributing guide (${(repo.contributingGuidelines.resourcePath ?? 'CONTRIBUTING').split('/blob/').pop().replace(/^[^/]+\//, '')})` });
  } else {
    signals.push({ ok: false, text: 'No contributing guide' });
  }
  if (repo.codeOfConduct) score += 1;
  if (repo.licenseInfo && repo.licenseInfo.spdxId !== 'NOASSERTION') {
    score += 1;
  } else {
    signals.push({ ok: false, text: 'No recognised open-source license' });
  }

  score = Math.min(10, score);
  const grade = score >= 7 ? 'great' : score >= 4 ? 'ok' : 'risky';
  return { score, grade, signals };
}

/** Labels that conventionally mark newcomer-friendly issues. */
export function beginnerLabels(labelNames) {
  const strong = labelNames.filter((l) => /good.?first|first.?timer|beginner|newcomer|starter|easy|e-easy|low.?hanging/i.test(l));
  if (strong.length) return strong;
  return labelNames.filter((l) => /help.?wanted|contributions?.?welcome|up.?for.?grabs/i.test(l));
}
