/** Project sizes, by stars. Smaller projects review faster; huge ones have more process. */
export const SIZES = {
  small: { label: 'Small', hint: '50–1k stars · maintainers often reply fast', stars: '50..1000' },
  medium: { label: 'Medium', hint: '1k–10k stars', stars: '1000..10000' },
  large: { label: 'Large', hint: '10k+ stars · more process, slower reviews', stars: '>=10000' },
  any: { label: 'Any size', hint: '50+ stars', stars: '>=50' },
};

/**
 * Build a GitHub repository-search query for projects that are active and have beginner issues open.
 * Uses GitHub's own `good-first-issues:` qualifier, so this searches every public repo, not a curated list.
 */
export function buildRepoQuery({ language, topic, size = 'any', minBeginnerIssues = 3, now = Date.now() }) {
  const since = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const parts = [
    `good-first-issues:>=${minBeginnerIssues}`,
    `stars:${(SIZES[size] ?? SIZES.any).stars}`,
    `pushed:>=${since}`,
    'archived:false',
    'fork:false',
    'is:public',
  ];
  if (language) parts.push(`language:"${language}"`);
  const t = (topic ?? '').trim();
  if (t) parts.unshift(`${t} in:name,description,topics`);
  return parts.join(' ');
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
