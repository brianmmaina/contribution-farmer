import { run, CommandError } from './exec.js';
import { chunk } from './lib/search.js';

/**
 * Thin wrapper over the `gh` CLI so we inherit the user's existing GitHub auth.
 * Every call goes through the official API and stays well inside its rate limits;
 * if a limit is ever hit, GitHub just asks us to wait, and we say so plainly.
 */
export class RateLimitError extends Error {}

function gh(args, opts) {
  try {
    return run('gh', args, opts);
  } catch (err) {
    if (err instanceof CommandError && /rate limit|abuse detection|HTTP 429/i.test(err.stderr)) {
      throw new RateLimitError('GitHub asked us to slow down (rate limit). Wait a minute and try again — this is a temporary pause, not a penalty.');
    }
    throw err;
  }
}

export function graphql(query, variables = {}) {
  const out = gh(['api', 'graphql', '--input', '-'], {
    input: JSON.stringify({ query, variables }),
  });
  const parsed = JSON.parse(out);
  if (parsed.errors?.length) throw new Error(parsed.errors.map((e) => e.message).join('\n'));
  return parsed.data;
}

export function rest(path, { method = 'GET', fields = {} } = {}) {
  const args = ['api', path, '-X', method];
  for (const [k, v] of Object.entries(fields)) args.push('-f', `${k}=${v}`);
  return JSON.parse(gh(args) || 'null');
}

export function viewerLogin() {
  return gh(['api', 'user', '--jq', '.login']);
}

/** Accepts owner/repo, a github.com repo URL, or an issue URL. */
export function parseRepoRef(input) {
  if (!input) return null;
  const s = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const url = s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)(?:\/(?:issues|pull)\/(\d+))?/i);
  if (url) return { owner: url[1], name: url[2], issue: url[3] ? Number(url[3]) : undefined };
  const short = s.match(/^([\w.-]+)\/([\w.-]+)(?:#(\d+))?$/);
  if (short) return { owner: short[1], name: short[2], issue: short[3] ? Number(short[3]) : undefined };
  return null;
}

const REPO_FIELDS = `
  nameWithOwner
  description
  url
  stargazerCount
  pushedAt
  isArchived
  isFork
  viewerPermission
  primaryLanguage { name }
  defaultBranchRef { name }
  licenseInfo { spdxId }
  codeOfConduct { name }
  contributingGuidelines { resourcePath }
  openIssues: issues(states: OPEN) { totalCount }
  recentMerged: pullRequests(states: MERGED, first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) {
    nodes { mergedAt authorAssociation }
  }
  labels(first: 100) { nodes { name } }
`;

export function fetchRepo(owner, name) {
  const data = graphql(
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${REPO_FIELDS} } }`,
    { owner, name },
  );
  return data.repository;
}

/** Fetch several repos in one round-trip using aliases. Missing repos come back null. */
export function fetchRepos(refs) {
  if (!refs.length) return [];
  // Keep each GraphQL query small so it stays cheap against the rate limit.
  if (refs.length > 15) return chunk(refs, 15).flatMap((part) => fetchRepos(part));
  const parts = refs.map(
    (r, i) => `r${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.name)}) { ${REPO_FIELDS} }`,
  );
  let data;
  try {
    data = graphql(`query { ${parts.join('\n')} }`);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    // One bad repo fails the whole aliased query; fall back to one at a time.
    return refs.map((r) => {
      try {
        return fetchRepo(r.owner, r.name);
      } catch {
        return null;
      }
    });
  }
  return refs.map((_, i) => data[`r${i}`]);
}

const ISSUE_FIELDS = `
  number
  title
  url
  body
  createdAt
  updatedAt
  locked
  author { login }
  assignees(first: 3) { totalCount nodes { login } }
  labels(first: 10) { nodes { name } }
  comments(last: 8) { totalCount nodes { author { login } authorAssociation body createdAt } }
  timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 20) {
    nodes {
      ... on CrossReferencedEvent { source { ... on PullRequest { number state url author { login } } } }
      ... on ConnectedEvent { subject { ... on PullRequest { number state url author { login } } } }
    }
  }
`;

export function fetchIssues(owner, name, labels) {
  const data = graphql(
    `query($owner: String!, $name: String!, $labels: [String!]) {
      repository(owner: $owner, name: $name) {
        issues(first: 40, states: OPEN, labels: $labels, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    }`,
    { owner, name, labels: labels.length ? labels : null },
  );
  return data.repository.issues.nodes;
}

export function fetchIssue(owner, name, number) {
  const data = graphql(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) { __typename ... on Issue { ${ISSUE_FIELDS} } } }
    }`,
    { owner, name, number },
  );
  const node = data.repository.issueOrPullRequest;
  if (!node) throw new Error(`#${number} not found in ${owner}/${name}`);
  if (node.__typename !== 'Issue') throw new Error(`#${number} is a pull request, not an issue`);
  return node;
}

/** Search across GitHub for beginner-friendly open issues. */
export function searchBeginnerIssues({ language, topic, label = 'good first issue' }) {
  const q = [
    'is:issue',
    'is:open',
    'no:assignee',
    'archived:false',
    `label:"${label}"`,
    language ? `language:${language}` : '',
    'comments:<8',
    topic || '',
  ]
    .filter(Boolean)
    .join(' ');
  const out = gh(['api', '-X', 'GET', 'search/issues', '-f', `q=${q}`, '-f', 'sort=updated', '-f', 'per_page=100']);
  return JSON.parse(out).items || [];
}

/** Search every public repo on GitHub with a repository-search query. */
export function searchRepos(q, { page = 1, perPage = 30, sort = 'updated' } = {}) {
  const out = gh(['api', '-X', 'GET', 'search/repositories', '-f', `q=${q}`, '-f', `sort=${sort}`, '-f', `per_page=${perPage}`, '-f', `page=${page}`]);
  const data = JSON.parse(out);
  return { total: data.total_count ?? 0, items: data.items ?? [] };
}
