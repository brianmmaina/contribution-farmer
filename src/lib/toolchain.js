import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { classifyCommand } from './contributing.js';

const read = (root, f) => {
  try {
    return readFileSync(join(root, f), 'utf8');
  } catch {
    return null;
  }
};
const has = (root, f) => existsSync(join(root, f));

function nodeToolchain(root, out) {
  const raw = read(root, 'package.json');
  if (!raw) return;
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return;
  }
  const declared = (pkg.packageManager || '').split('@')[0];
  const pm =
    declared ||
    (has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'yarn.lock') ? 'yarn' : has(root, 'bun.lockb') || has(root, 'bun.lock') ? 'bun' : 'npm');
  out.ecosystems.push(`Node (${pm})`);
  if (declared && declared !== 'npm') out.setup.push('corepack enable');
  out.setup.push(pm === 'npm' && has(root, 'package-lock.json') ? 'npm ci' : `${pm} install`);

  const scripts = pkg.scripts || {};
  const runScript = (name) => (pm === 'npm' ? (name === 'test' ? 'npm test' : `npm run ${name}`) : `${pm} ${name === 'test' ? 'test' : `run ${name}`}`);
  if (scripts.test && !/no test specified/.test(scripts.test)) out.test.push(runScript('test'));
  for (const name of ['lint', 'typecheck', 'type-check', 'check-types', 'tsc', 'format:check', 'fmt:check', 'check']) {
    if (scripts[name]) out.lint.push(runScript(name));
  }
  if (scripts.build) out.build.push(runScript('build'));

  const nodeReq = read(root, '.nvmrc')?.trim() || read(root, '.node-version')?.trim() || pkg.engines?.node;
  if (nodeReq) out.runtimes.push({ name: 'node', required: nodeReq, file: has(root, '.nvmrc') ? '.nvmrc' : has(root, '.node-version') ? '.node-version' : 'package.json engines' });
}

function pythonToolchain(root, out) {
  const pyproject = read(root, 'pyproject.toml') || '';
  if (!pyproject && !has(root, 'setup.py') && !has(root, 'requirements.txt')) return;
  out.ecosystems.push('Python');
  let prefix;
  if (has(root, 'uv.lock')) {
    out.setup.push('uv sync');
    prefix = 'uv run ';
  } else if (has(root, 'poetry.lock') || /\[tool\.poetry\]/.test(pyproject)) {
    out.setup.push('poetry install');
    prefix = 'poetry run ';
  } else if (has(root, 'pdm.lock')) {
    out.setup.push('pdm install');
    prefix = 'pdm run ';
  } else {
    const dev = ['requirements-dev.txt', 'requirements_dev.txt', 'dev-requirements.txt', 'requirements/dev.txt'].find((f) => has(root, f));
    const install = dev
      ? `.venv/bin/pip install -r ${dev}`
      : pyproject || has(root, 'setup.py')
        ? `.venv/bin/pip install -e ${/optional-dependencies[\s\S]*?\bdev\s*=/.test(pyproject) ? '".[dev]"' : '.'}`
        : '.venv/bin/pip install -r requirements.txt';
    out.setup.push(`python3 -m venv .venv && ${install}`);
    prefix = '.venv/bin/';
  }
  if (has(root, 'tox.ini')) out.test.push('tox');
  else if (has(root, 'noxfile.py')) out.test.push('nox');
  else if (/pytest/.test(pyproject) || has(root, 'pytest.ini') || has(root, 'tests') || has(root, 'test')) out.test.push(`${prefix}pytest`);
  if (/\[tool\.ruff/.test(pyproject) || has(root, 'ruff.toml') || has(root, '.ruff.toml')) out.lint.push(`${prefix}ruff check .`);
  if (/\[tool\.mypy\]/.test(pyproject) || has(root, 'mypy.ini')) out.lint.push(`${prefix}mypy .`);

  const pyReq = read(root, '.python-version')?.trim();
  if (pyReq) out.runtimes.push({ name: 'python', required: pyReq, file: '.python-version' });
}

function otherToolchains(root, out) {
  if (has(root, 'Cargo.toml')) {
    out.ecosystems.push('Rust');
    out.build.push('cargo build');
    out.test.push('cargo test');
    out.lint.push('cargo fmt --check', 'cargo clippy --all-targets');
  }
  const gomod = read(root, 'go.mod');
  if (gomod) {
    out.ecosystems.push('Go');
    out.setup.push('go mod download');
    out.test.push('go test ./...');
    out.lint.push('go vet ./...');
    const v = gomod.match(/^go (\d+\.\d+)/m);
    if (v) out.runtimes.push({ name: 'go', required: v[1], file: 'go.mod' });
  }
  if (has(root, 'Gemfile')) {
    out.ecosystems.push('Ruby');
    out.setup.push('bundle install');
    if (has(root, 'spec')) out.test.push('bundle exec rspec');
    else if (has(root, 'Rakefile')) out.test.push('bundle exec rake test');
    if (has(root, '.rubocop.yml')) out.lint.push('bundle exec rubocop');
  }
  if (has(root, 'gradlew')) {
    out.ecosystems.push('JVM (Gradle)');
    out.test.push('./gradlew test');
  } else if (has(root, 'pom.xml')) {
    out.ecosystems.push('JVM (Maven)');
    out.test.push(has(root, 'mvnw') ? './mvnw test' : 'mvn test');
  }
  if (has(root, 'composer.json')) {
    out.ecosystems.push('PHP');
    out.setup.push('composer install');
  }

  const makefile = read(root, 'Makefile') || read(root, 'makefile');
  if (makefile) {
    const targets = new Set([...makefile.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)].map((m) => m[1]));
    for (const t of ['setup', 'bootstrap', 'install-dev', 'dev-setup', 'deps']) if (targets.has(t)) out.setup.push(`make ${t}`);
    if (targets.has('test')) out.test.push('make test');
    for (const t of ['lint', 'check', 'fmt-check', 'format-check']) if (targets.has(t)) out.lint.push(`make ${t}`);
  }

  if (has(root, '.gitmodules')) out.setup.unshift('git submodule update --init --recursive');
  if (has(root, '.pre-commit-config.yaml')) out.setup.push('pre-commit install');
}

/** Inspect the checkout and propose setup / test / lint commands. */
export function detectToolchain(root) {
  const out = { ecosystems: [], setup: [], test: [], lint: [], build: [], runtimes: [] };
  nodeToolchain(root, out);
  pythonToolchain(root, out);
  otherToolchains(root, out);
  return out;
}

const normalize = (c) => c.replace(/\s+/g, ' ').replace(/^npm run test$/, 'npm test').trim();

/**
 * Combine commands lifted from CONTRIBUTING with ones we detected.
 * Both are kept (deduped). A guide command is on by default unless it looks like a niche variant
 * (extra flags/args), in which case the standard detected command is preferred.
 */
export function mergeCommands(docCommands, toolchain) {
  const plan = { setup: [], test: [], lint: [], build: [], other: [] };
  const seen = new Set();
  const add = (bucket, cmd, source, on) => {
    const key = normalize(cmd);
    if (seen.has(key)) return;
    seen.add(key);
    plan[bucket].push({ cmd, source, default: on });
  };
  const simple = (cmd) => cmd.split(/\s+/).length <= 3 && !/\s-\w/.test(cmd.replace(/^\S+ -- /, ''));
  for (const cmd of docCommands) {
    const bucket = classifyCommand(cmd);
    add(bucket, cmd, 'guide', bucket === 'setup' || simple(cmd));
  }
  for (const bucket of ['setup', 'test', 'lint', 'build']) {
    const guideCovers = plan[bucket].some((c) => c.default);
    for (const cmd of toolchain[bucket]) add(bucket, cmd, 'detected', bucket === 'setup' || !guideCovers);
  }
  return plan;
}

function major(v) {
  const m = String(v).match(/(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

/** Compare required runtime versions with what's installed. Returns human-readable warnings. */
export function checkRuntimes(runtimes, installed) {
  const warnings = [];
  for (const rt of runtimes) {
    const have = installed[rt.name];
    if (have === undefined) continue;
    if (have === null) {
      warnings.push(`${rt.name} is required (${rt.required} per ${rt.file}) but isn't installed`);
      continue;
    }
    const need = major(rt.required);
    const got = major(have);
    if (!need || !got) continue;
    const isMinimum = /^[>^~]|\.x$|^\d+$/.test(rt.required.trim()) && !/^</.test(rt.required.trim());
    const tooOld = got[0] < need[0] || (got[0] === need[0] && rt.name !== 'node' && got[1] < need[1]);
    const mismatch = !isMinimum && got[0] !== need[0];
    if (tooOld || mismatch) warnings.push(`${rt.file} asks for ${rt.name} ${rt.required}, you have ${have}`);
  }
  return warnings;
}

export function listFilesSafe(root, dir) {
  try {
    return readdirSync(join(root, dir));
  } catch {
    return [];
  }
}
