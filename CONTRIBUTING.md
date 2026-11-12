# Contributing

Thanks for helping! This tool exists to make first contributions better, so it should be an easy project to contribute to as well.

## Setup

```bash
git clone https://github.com/<your-username>/contribution-farmer
cd contribution-farmer
npm ci
npm test
```

Run the CLI from your checkout with `node bin/cli.js`. Running `npm link` gives you `contribution-farmer` and `cfarm` on your PATH.

## Guidelines

- Open an issue first for anything larger than a small fix, so we can agree on the approach.
- Keep analysis logic in `src/lib/` as pure functions over plain data, and add a test in `test/` for any new heuristic.
- Every command that runs on a user's machine, and every action that is visible on GitHub (forks, comments, PRs), must be shown to the user and confirmed first.
- Stay well inside GitHub's API rate limits: batch GraphQL queries and avoid loops of requests.
- Write commit messages that say what changed and why.
