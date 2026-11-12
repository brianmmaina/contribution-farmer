<div align="center">

# 🌱 contribution-farmer

**From "I want to contribute to open source" to a pull request maintainers actually want to merge.**

[![npm](https://img.shields.io/npm/v/contribution-farmer?color=2ea44f)](https://www.npmjs.com/package/contribution-farmer)
[![tests](https://github.com/brianmmaina/contribution-farmer/actions/workflows/test.yml/badge.svg)](https://github.com/brianmmaina/contribution-farmer/actions/workflows/test.yml)
[![node](https://img.shields.io/node/v/contribution-farmer)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```bash
npx contribution-farmer
```

[Quick start](#-quick-start) · [How it works](#-how-it-works) · [Commands](#-commands) · [Account safety](#-is-it-safe-for-my-github-account) · [Development](#-development)

</div>

---

## Why

Most first contributions go wrong in the same few ways:

| Common mistake | What contribution-farmer does |
| --- | --- |
| Picking an issue someone is already working on | Hides assigned issues and ones with an open PR, and warns about recent "can I take this?" comments |
| Picking a repo where PRs sit unreviewed for months | Scores each repo on how often it actually merges PRs from outside contributors |
| Skipping the setup steps in `CONTRIBUTING.md` | Reads the guide and runs its setup commands, after you confirm each one |
| Ignoring the commit style, DCO sign-off, changesets or PR template | Detects the house rules and checks your branch against them |
| A PR with no tests, a stray `console.log` or an unrelated lockfile diff | Runs a reviewer-style checklist before you open the PR |

## 🚀 Quick start

You need **[Node.js](https://nodejs.org) 18.17+**, **git**, and the **[GitHub CLI](https://cli.github.com)**:

```bash
brew install gh                    # macOS
winget install --id GitHub.cli     # Windows
```

Then run:

```bash
npx contribution-farmer
```

The first time, it offers to log you in to **your own** GitHub account in the browser. That's the whole setup.

To keep it installed, with the short alias `cfarm`:

```bash
npm install -g contribution-farmer
```

## 🧭 How it works

```
 find a repo ─▶ pick an issue ─▶ fork + clone ─▶ read CONTRIBUTING ─▶ set up ─▶ branch ─▶ code ─▶ check ─▶ pr
```

<details open>
<summary><b>1. Find a project</b> — search every public repo on GitHub</summary>

<br>

`find` can search two ways:

- **Browse projects (the default):** keeps active projects (pushed in the last 30 days) that have at least 3 open `good first issue`s. You can filter by language, topic and size. Small projects (50–1k stars) usually review fastest. "Load more" pages through further results.
- **Browse beginner issues:** starts from open, unassigned beginner issues and groups them by repo.

Each repo gets a **0–10 newcomer-friendliness score**. The score is based on:
- recent activity
- how many recently merged PRs came **from outside contributors**, the best sign that someone will review your work
- whether it has a contributing guide, a code of conduct and a license

Repos whose beginner issues are mass-produced from one template ("issue mills") are pushed down the list.
</details>

<details>
<summary><b>2. Pick an issue</b> — only ones that are actually free</summary>

<br>

It finds the repo's beginner labels (`good first issue`, `first-timers-only`, `help wanted`, …). It hides issues that are assigned or have an open PR. It also warns about issues someone recently claimed in a comment, issues with very thin descriptions, and very old issues.
</details>

<details>
<summary><b>3. Fork, clone and set up</b> — the project's way</summary>

<br>

- Forks with `gh` and does a fast partial clone (`--filter=blob:none`). It also adds an `upstream` remote.
- Finds `CONTRIBUTING.md` (in the repo root, `.github/` or `docs/`) and shows you its key rules.
- Learns the commit style from commitlint config or recent history, and notes requirements like DCO sign-off, a CLA, Changesets or the PR template.
- Pulls setup, test and lint commands from the guide. It fills gaps by detecting the toolchain: npm/pnpm/yarn/bun, uv/poetry/pip, cargo, go, bundler, gradle/maven, Makefile, pre-commit and submodules.
- **Every command is shown and confirmed before it runs.**
- Can run the tests once as a **baseline**, so you later know which failures were already there.
</details>

<details>
<summary><b>4. Branch and find where to start</b></summary>

<br>

- Cuts a branch from the latest upstream and names it after the issue, e.g. `fix/123-crash-on-empty-input`.
- Searches the code for identifiers and paths mentioned in the issue, then lists the files most likely to matter.
- Can post a comment claiming the issue. You have to write your planned approach in it before it will post.
</details>

<details>
<summary><b>5. Check before you open the PR</b></summary>

<br>

`check` compares your branch with upstream and reports **pass / warn / fail** for:

- working on the default branch, uncommitted work, being behind upstream
- commit messages that are off-style, vague or too long, and missing DCO sign-off
- diff size, whitespace-only edits, lockfile changes with no dependency change
- code changes with no test changes
- leftover `console.log`, `debugger`, `breakpoint()` or `dbg!`, and new TODOs
- a missing changeset

It then runs the tests and linters and compares the results with the baseline.
</details>

<details>
<summary><b>6. Open the PR</b></summary>

<br>

`pr` fills in the project's PR template. It links the issue and lists the commands that passed under "how I tested this". Then it pushes your branch and opens the PR **pre-filled in your browser**, so you review it one last time. It can create a draft instead. Checkboxes are left for you to tick honestly.
</details>

Your progress is saved in `.git/contribution-farmer.json`, so it stays with the clone and can never be committed by accident.

## 📋 Commands

| Command | What it does |
| --- | --- |
| `npx contribution-farmer` | Start a contribution. Find a project, or bring one you already have in mind |
| `npx contribution-farmer owner/repo` | Start on a specific repo. Repo and issue URLs work too |
| `npx contribution-farmer find` | Search all public repos for welcoming projects |
| `npx contribution-farmer status` | Where you are and what to do next (run it inside the clone) |
| `npx contribution-farmer check` | Reviewer-style checklist, plus the project's tests and linters |
| `npx contribution-farmer pr` | Push your branch and open a pre-filled pull request |

| Option | |
| --- | --- |
| `--lang <language>` | Language filter, e.g. `Python` |
| `--topic <words>` | Topic filter, e.g. `cli`, `testing`, `games` |
| `--size <size>` | `small` · `medium` · `large` · `any` |
| `--issues` | Start `find` from beginner issues instead of projects |
| `--dir <path>` | Where to clone |
| `--no-run` | Run `check` without running tests |

```bash
npx contribution-farmer find --lang Python --topic cli --size small
```

## 🔒 Is it safe for my GitHub account?

**Yes.** The tool has no account, token or server of its own. Everything goes through GitHub's official API using **your own** `gh` login. It never sees or stores your token, and it shows which account it's using when it starts. To use a different account, run `gh auth switch`.

- **Searching:** a search makes a few requests, about the same as browsing github.com. If GitHub's rate limit is ever hit, the tool tells you to wait a minute. That's a short pause, not a penalty.
- **Actions other people can see:** forking, commenting and opening a PR each happen once, for the repo and issue you picked, after you confirm. By default you click Create on the PR yourself.

The tool won't mass-open PRs or comments, which is what gets accounts flagged.

## 🛠 Development

```bash
git clone https://github.com/brianmmaina/contribution-farmer
cd contribution-farmer
npm install
npm test                 # unit tests, no network needed
node bin/cli.js --help
```

```
bin/cli.js               entry point
src/index.js             arg parsing, login check, command dispatch
src/github.js            gh api / GraphQL wrappers, rate-limit handling
src/commands/            start · find · check · pr · status
src/lib/health.js        newcomer-friendliness score
src/lib/issues.js        issue availability, claim + issue-mill detection
src/lib/search.js        repo-search query building
src/lib/contributing.js  CONTRIBUTING parsing: commands + rules
src/lib/toolchain.js     ecosystem detection, runtime checks
src/lib/conventions.js   commit style, DCO/CLA/changesets, PR templates
src/lib/hints.js         issue → relevant files
src/lib/checks.js        pre-PR checklist
src/lib/prbody.js        PR template filling
```

The analysis modules are pure functions over plain data, so they're unit-tested without network access. See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute to this project.

## License

[MIT](LICENSE) © Brian Maina
