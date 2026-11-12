import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { hasCommand, run, runLive } from './exec.js';
import { ask, p, pc } from './ui.js';

const HELP = `
${pc.bold('contribution-farmer')} — from "I want to contribute" to a PR maintainers want to merge.

${pc.bold('Usage')}
  npx contribution-farmer [owner/repo | repo URL | issue URL]   start a contribution
  npx contribution-farmer find      search all public repos for a welcoming project
  npx contribution-farmer status    where you are and what to do next
  npx contribution-farmer check     reviewer-style checklist + run tests/linters
  npx contribution-farmer pr        push and open a pre-filled pull request

${pc.bold('Options')}
  --dir <path>        where to clone (start)
  --lang <language>   language filter (find/start)
  --topic <words>     topic filter, e.g. cli, testing, games (find/start)
  --size <size>       small | medium | large | any (find/start)
  --issues            in find, start from beginner issues instead of projects
  --no-run            check without running tests/linters
  -h, --help          show this help
  -v, --version       show version

Requires git and the GitHub CLI (gh), logged in with \`gh auth login\`.
`;

const GH_INSTALL = {
  darwin: 'brew install gh',
  win32: 'winget install --id GitHub.cli',
  linux: 'see https://github.com/cli/cli/blob/trunk/docs/install_linux.md',
};

/**
 * Make sure git and gh are installed and the person running this is logged in.
 * Everything uses *their* gh login, so nothing here ever touches anyone else's account.
 */
async function preflight() {
  const missing = [];
  if (!hasCommand('git')) missing.push(`git — https://git-scm.com/downloads`);
  if (!hasCommand('gh')) {
    missing.push(`GitHub CLI — https://cli.github.com  (${GH_INSTALL[process.platform] ?? 'see https://cli.github.com'})`);
  }
  if (missing.length) {
    p.log.error(`Install these first, then run this again:\n${missing.map((m) => `  • ${m}`).join('\n')}`);
    process.exit(1);
  }

  if (!run('gh', ['auth', 'status'], { allowFail: true }).ok) {
    p.log.info('This tool acts as you on GitHub, so you need to log in to your own GitHub account once.');
    const go = await ask(p.confirm({ message: 'Log in to GitHub now? (runs `gh auth login`)', initialValue: true }));
    if (!go) {
      p.outro(`Run ${pc.cyan('gh auth login')} whenever you're ready, then run this again.`);
      process.exit(0);
    }
    const code = await runLive('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web']);
    if (code !== 0 || !run('gh', ['auth', 'status'], { allowFail: true }).ok) {
      p.log.error(`Login didn't finish. Run ${pc.cyan('gh auth login')} and try again.`);
      process.exit(1);
    }
    // Lets `git push` to your fork use the same login.
    run('gh', ['auth', 'setup-git'], { allowFail: true });
  }

  const who = run('gh', ['api', 'user', '--jq', '.login'], { allowFail: true });
  if (who.ok && who.stdout.trim()) {
    p.log.info(`Using your GitHub account ${pc.bold('@' + who.stdout.trim())} ${pc.dim('(switch with `gh auth switch` or `gh auth login`)')}`);
  }
}

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      lang: { type: 'string' },
      topic: { type: 'string' },
      size: { type: 'string' },
      issues: { type: 'boolean', default: false },
      'no-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.help) return console.log(HELP);
  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return console.log(pkg.version);
  }

  const [first, ...rest] = positionals;
  const command = ['find', 'status', 'check', 'pr', 'start', 'help'].includes(first) ? first : 'start';
  const target = command === 'start' ? (first === 'start' ? rest[0] : first) : undefined;
  if (command === 'help') return console.log(HELP);

  if (values.size && !['small', 'medium', 'large', 'any'].includes(values.size)) {
    console.error('--size must be one of: small, medium, large, any');
    process.exit(1);
  }
  const searchOpts = { language: values.lang, topic: values.topic, size: values.size, mode: values.issues ? 'issues' : undefined };

  p.intro(pc.bgGreen(pc.black(' contribution-farmer ')));
  await preflight();

  try {
    switch (command) {
      case 'find': {
        const { find } = await import('./commands/find.js');
        const ref = await find(searchOpts);
        if (ref) {
          const { start } = await import('./commands/start.js');
          await start(`${ref.owner}/${ref.name}`, { dir: values.dir });
        }
        break;
      }
      case 'status':
        await (await import('./commands/status.js')).status();
        break;
      case 'check':
        await (await import('./commands/check.js')).check({ runCommands: !values['no-run'] });
        break;
      case 'pr':
        await (await import('./commands/pr.js')).pr();
        break;
      default:
        await (await import('./commands/start.js')).start(target, { dir: values.dir, ...searchOpts });
    }
  } catch (err) {
    p.log.error(err.message);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  }
}
