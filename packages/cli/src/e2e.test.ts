import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NightwatchStore } from '@nightwatch-agent/daemon';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const bin = path.join(repoRoot, 'packages', 'cli', 'dist', 'bin.js');
const fakeAgent = path.join(repoRoot, 'scripts', 'fake-agent.mjs');

function sh(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
  try {
    return execFileSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`${e.message}\n--- stdout ---\n${e.stdout ?? ''}\n--- stderr ---\n${e.stderr ?? ''}`);
  }
}

test('end-to-end guarded run with the fake agent', { timeout: 120_000 }, () => {
  const tmpRoot = path.resolve(here, '..', '.tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const base = fs.mkdtempSync(path.join(tmpRoot, 'e2e-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'nw@test');
  git('config', 'user.name', 'nw');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node test.js' } }));
  fs.writeFileSync(path.join(repo, 'test.js'), "console.log('Tests: 1 failed, 2 passed, 3 total'); process.exit(1);");
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET_KEY=abc\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const fingerprintBefore = git('status', '--porcelain') + git('rev-parse', 'HEAD');

  const initOut = sh(['init', '--preset', 'safe-overnight'], repo);
  assert.match(initOut, /Wrote \.nightwatch[\\/]policy\.yaml/);
  fs.writeFileSync(
    path.join(repo, '.nightwatch', 'config.yaml'),
    `agent: fake\ndashboard_port: 47820\ntest_command: npm test\nagents:\n  fake:\n    template: '\"${process.execPath.replace(/\\/g, '/')}\" \"${fakeAgent.replace(/\\/g, '/')}\" {prompt}'\n    stream: claude-stream-json\n    hooks: none\n    shims: false\n`,
  );

  const runOut = sh(['run', '--task', 'Exercise the app and report failures', '--agent', 'fake', '--hours', '0.1', '--budget-usd', '1', '--port', '47820'], repo);
  assert.match(runOut, /Created isolated worktree/);
  assert.match(runOut, /Report:/);

  const store = new NightwatchStore(path.join(repo, '.nightwatch', 'nightwatch.db'));
  try {
    const s = store.latestSession()!;
    assert.equal(s.status, 'completed', `status ${s.status}: ${s.stop_reason}`);
    assert.equal(s.main_tree_unchanged, 1);
    assert.equal(s.cost_usd, 0.0123);
    assert.equal(s.model, 'fake-model-1');
    const events = store.listEvents(s.id);
    const denied = events.filter((e) => e.decision === 'deny');
    assert.deepEqual(
      denied.map((e) => e.reason_code),
      ['PROD_RISK', 'SECRET_PATH', 'SECRET_PATH', 'NETWORK_NOT_ALLOWED'],
      JSON.stringify(denied.map((e) => [e.tool, e.input_summary, e.reason_code])),
    );
    assert.ok(events.some((e) => e.tool === 'Bash' && e.decision === 'allow' && e.result_summary?.startsWith('exit 0')), 'post-tool results are recorded');
    const tests = store.listTestRuns(s.id);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].failed, 1);
    assert.ok(fs.existsSync(s.worktree), 'worktree kept for review');
    assert.ok(fs.existsSync(path.join(s.worktree, 'FIX_NOTES.md')));
    const runDir = path.join(repo, '.nightwatch', 'runs', s.id);
    assert.ok(fs.existsSync(path.join(runDir, 'report.html')));
    const patch = fs.readFileSync(path.join(runDir, 'changes.patch'), 'utf8');
    assert.match(patch, /FIX_NOTES\.md/);
    assert.ok(!patch.includes('NIGHTWATCH_FINDINGS'), 'findings file is excluded from the patch');
    const html = fs.readFileSync(path.join(runDir, 'report.html'), 'utf8');
    assert.match(html, /test\.js always fails/);
    assert.match(html, /PROD_RISK/);
    assert.match(html, /unchanged/);
  } finally {
    store.close();
  }

  const fingerprintAfter = git('status', '--porcelain') + git('rev-parse', 'HEAD');
  assert.equal(fingerprintAfter, fingerprintBefore, 'main tree untouched');

  const status = sh(['status'], repo);
  assert.match(status, /completed/);
  const md = sh(['report', 'latest', '--md'], repo);
  assert.match(md, /## Findings/);
  const cleaned = sh(['clean', 'latest'], repo);
  assert.match(cleaned, /Removed worktree/);
  assert.match(cleaned, /Deleted branch/);
  assert.equal(git('worktree', 'list').split('\n').filter(Boolean).length, 1);
  fs.rmSync(base, { recursive: true, force: true });
});
