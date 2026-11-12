import { run } from '../exec.js';

const STOP = new Set(
  'about after again also because been before being both but bug can cannot could does doing done each error from have having here into issue just like make more most need only other over same should some such than that their them then there these they this those through under using very want were what when where which while will with would your feature request expected actual behavior behaviour steps reproduce version true false null undefined return function const class import export'.split(
    ' ',
  ),
);

/** Pull searchable terms out of an issue: code spans, file paths, identifiers, quoted error text. */
export function extractSearchTerms(title = '', body = '') {
  const text = `${title}\n${body}`.replace(/```[\s\S]*?```/g, (block) => block.split('\n').slice(0, 6).join('\n'));
  const terms = new Map();
  const add = (t, weight) => {
    t = t.trim().replace(/^[./]+|[.,:;()]+$/g, '');
    if (t.length < 4 || t.length > 60 || STOP.has(t.toLowerCase())) return;
    terms.set(t, Math.max(terms.get(t) ?? 0, weight));
  };

  for (const m of text.matchAll(/`([^`\n]{3,60})`/g)) {
    const inner = m[1].replace(/\(.*\)$/, '');
    if (/^[\w./@-]+$/.test(inner)) add(inner, 3);
  }
  for (const m of text.matchAll(/(?:^|[\s(])((?:[\w@-]+\/)+[\w.-]+\.[a-z]{1,5})\b/gm)) add(m[1], 4);
  for (const m of text.matchAll(/\b([A-Za-z_][\w]*[a-z][A-Z][\w]*|[a-z]+(?:_[a-z0-9]+)+|[A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) add(m[1], 2);
  for (const m of text.matchAll(/(?:Error|Exception|Warning)[:\s]+"?([^"\n]{8,60})"?/g)) add(m[1], 2);
  for (const m of text.matchAll(/--([a-z][\w-]{2,})/g)) add(`--${m[1]}`, 2);

  return [...terms.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([term, weight]) => ({ term, weight }));
}

const NOISE = /(^|\/)(node_modules|vendor|dist|build|\.next|coverage|__snapshots__|fixtures?)\/|\.(lock|min\.js|map|snap|svg|png|jpg)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|CHANGELOG\.md|CHANGES\.(md|rst))$/i;

const DOCS = /\.(md|mdx|rst|txt)$|(^|\/)docs?\//i;

/** Rank files in the checkout by how many of the issue's terms they mention. */
export function findRelevantFiles(root, terms, limit = 8) {
  const scores = new Map();
  const bump = (file, w, term) => {
    if (NOISE.test(file)) return;
    if (DOCS.test(file)) w *= 0.4; // prefer source over prose
    const entry = scores.get(file) ?? { file, score: 0, matched: [] };
    entry.score += w;
    if (!entry.matched.includes(term)) entry.matched.push(term);
    scores.set(file, entry);
  };

  const tracked = run('git', ['ls-files'], { cwd: root, allowFail: true }).stdout.split('\n');
  for (const { term, weight } of terms) {
    if (term.includes('/') || /\.[a-z]{1,5}$/.test(term)) {
      for (const f of tracked) if (f.endsWith(term) || f.includes(term)) bump(f, weight * 2, term);
    }
    const res = run('git', ['grep', '-l', '-I', '-F', '--', term], { cwd: root, allowFail: true });
    const files = res.stdout ? res.stdout.split('\n') : [];
    if (files.length > 40) continue; // too common to be a useful signal
    for (const f of files) bump(f, weight, term);
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.file.length - b.file.length).slice(0, limit);
}
