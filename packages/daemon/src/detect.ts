import fs from 'node:fs';
import path from 'node:path';

export interface ProjectDetection {
  language: string[];
  testCommand: string | null;
  allowCommands: string[];
  notes: string[];
}

/** Infer the test/lint/build commands a repository uses, to seed the policy allow list. */
export function detectProject(root: string): ProjectDetection {
  const has = (f: string) => fs.existsSync(path.join(root, f));
  const out: ProjectDetection = { language: [], testCommand: null, allowCommands: [], notes: [] };
  const add = (...cmds: string[]) => {
    for (const c of cmds) if (!out.allowCommands.includes(c)) out.allowCommands.push(c);
  };

  if (has('package.json')) {
    out.language.push('node');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
      const run = (s: string) => (pm === 'npm' ? (s === 'test' ? 'npm test' : `npm run ${s}`) : `${pm} ${s === 'test' ? 'test' : `run ${s}`}`);
      for (const s of ['test', 'lint', 'build', 'typecheck', 'check', 'format:check', 'test:unit', 'test:ci', 'coverage']) {
        if (scripts[s]) add(run(s));
      }
      if (scripts.test) out.testCommand = run('test');
      if (pm === 'npm') add('npm ci');
      else add(`${pm} install --frozen-lockfile`);
    } catch {
      out.notes.push('package.json could not be parsed');
    }
    if (has('tsconfig.json')) add('npx tsc --noEmit', 'npx tsc -p .');
  }
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt') || has('pytest.ini') || has('setup.cfg') || has('tox.ini')) {
    out.language.push('python');
    add('pytest', 'python -m pytest', 'python3 -m pytest', 'ruff check', 'ruff format --check', 'mypy', 'black --check', 'flake8');
    if (has('pyproject.toml')) {
      const t = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8');
      if (/\[tool\.poetry\]/.test(t)) add('poetry run pytest', 'poetry install');
      if (/\[tool\.uv\]/.test(t) || has('uv.lock')) add('uv run pytest', 'uv sync');
    }
    out.testCommand ??= 'pytest';
  }
  if (has('Cargo.toml')) {
    out.language.push('rust');
    add('cargo test', 'cargo build', 'cargo check', 'cargo clippy', 'cargo fmt --check', 'cargo fmt');
    out.testCommand ??= 'cargo test';
  }
  if (has('go.mod')) {
    out.language.push('go');
    add('go test', 'go build', 'go vet', 'gofmt -l', 'go mod tidy', 'staticcheck');
    out.testCommand ??= 'go test ./...';
  }
  if (has('Gemfile')) {
    out.language.push('ruby');
    add('bundle exec rspec', 'bundle exec rubocop', 'bundle exec rake test', 'bundle install');
    out.testCommand ??= 'bundle exec rspec';
  }
  if (has('composer.json')) {
    out.language.push('php');
    add('composer test', 'vendor/bin/phpunit', './vendor/bin/phpunit', 'composer install');
    out.testCommand ??= 'composer test';
  }
  if (has('pom.xml')) {
    out.language.push('java');
    add('mvn test', 'mvn -q test', 'mvn compile', 'mvn verify');
    out.testCommand ??= 'mvn test';
  }
  if (has('build.gradle') || has('build.gradle.kts')) {
    out.language.push('java');
    add('./gradlew test', './gradlew build', 'gradle test');
    out.testCommand ??= './gradlew test';
  }
  const dotnet = fs.readdirSync(root).some((f) => /\.(sln|csproj|fsproj)$/.test(f));
  if (dotnet) {
    out.language.push('dotnet');
    add('dotnet test', 'dotnet build');
    out.testCommand ??= 'dotnet test';
  }
  if (has('Makefile') || has('makefile')) {
    const mk = fs.readFileSync(path.join(root, has('Makefile') ? 'Makefile' : 'makefile'), 'utf8');
    for (const t of ['test', 'lint', 'check', 'build', 'unit', 'ci']) if (new RegExp(`^${t}:`, 'm').test(mk)) add(`make ${t}`);
    if (/^test:/m.test(mk)) out.testCommand ??= 'make test';
  }
  if (has('CMakeLists.txt')) {
    out.language.push('c/c++');
    add('cmake --build', 'ctest');
    out.testCommand ??= 'ctest';
  }
  if (!out.language.length) out.notes.push('no known project type detected; add your test command to allow.commands');
  return out;
}
