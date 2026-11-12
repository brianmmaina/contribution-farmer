const REF_PLACEHOLDER =
  /\b(fix(?:es|ed)?|close[sd]?|resolve[sd]?)(:?[ \t]*)#(?!\d)[ \t]*(?:\(?[\w ]*(?:issue|number|no\.?)[\w ]*\)?|<[^>\n]*>|\[[^\]\n]*\]|_+|x{2,}|n{2,})?/gi;

/**
 * Fill a project's PR template (or write a sensible one) for the given issue.
 * Checkboxes are left for the contributor to tick honestly.
 */
export function buildPRBody({ template, issueNumber, commits = [], tested = [] }) {
  if (template) {
    let body = template.replace(/\r\n/g, '\n');
    if (issueNumber) {
      body = body.replace(REF_PLACEHOLDER, (_m, verb, sep) => `${verb}${sep || ' '}#${issueNumber}`);
      body = body.replace(/#\s*<?issue[ _-]?(number|no\.?|#)?>?(?=\s|$)/gi, `#${issueNumber}`);
      // A reference inside an HTML comment is invisible and won't link the issue.
      const visible = body.replace(/<!--[\s\S]*?-->/g, '');
      if (!new RegExp(`#${issueNumber}\\b`).test(visible)) body = `Closes #${issueNumber}\n\n${body}`;
    }
    return body.trim() + '\n';
  }

  const lines = [];
  if (issueNumber) lines.push(`Closes #${issueNumber}`, '');
  lines.push('## What this changes', '');
  lines.push('<!-- One or two sentences: what was wrong, and what this PR does about it. -->', '');
  if (commits.length > 1) {
    lines.push('## Commits', '', ...commits.map((c) => `- ${c.subject}`), '');
  }
  lines.push('## How I tested it', '');
  if (tested.length) lines.push(...tested.map((t) => `- \`${t}\` passes`));
  lines.push('- <!-- manual steps you took to verify the fix -->', '');
  lines.push('## Notes for reviewers', '', '<!-- Anything you were unsure about, alternatives you considered, or follow-ups. -->', '');
  return lines.join('\n');
}

/** Default PR title: the single commit's subject, otherwise the issue title in the project's commit style. */
export function suggestTitle({ commits = [], issue, commitStyle }) {
  if (commits.length === 1) return commits[0].subject;
  const base = issue?.title ?? commits[0]?.subject ?? '';
  if (commitStyle === 'conventional' && !/^\w+(\(.+\))?!?: /.test(base)) {
    return `fix: ${base.charAt(0).toLowerCase()}${base.slice(1)}`;
  }
  return base;
}
