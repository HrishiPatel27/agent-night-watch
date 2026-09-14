import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PolicyContext } from '@nightwatch-agent/shared';
import { evaluate } from './engine.js';
import { runFixtures } from './fixtures.js';
import { safeOvernightPreset } from './presets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '..', '..', '..', 'fixtures', 'commands');

function makeCtx(): PolicyContext & { cleanup: () => void } {
  const tmpRoot = path.resolve(here, '..', '.tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const base = fs.mkdtempSync(path.join(tmpRoot, 'nw-engine-'));
  const scratch = path.join(base, 'scratch');
  fs.mkdirSync(scratch);
  fs.mkdirSync(path.join(base, 'project'));
  const projectRoot = fs.realpathSync(path.join(base, 'project'));
  const worktree = path.join(projectRoot, '.nightwatch', 'runs', 'r1', 'worktree');
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'app.ts'), 'export {}');
  fs.writeFileSync(path.join(worktree, 'src', 'index.ts'), 'export {}');
  fs.writeFileSync(path.join(worktree, 'package.json'), '{}');
  fs.writeFileSync(path.join(worktree, 'README.md'), '# x');
  fs.writeFileSync(path.join(worktree, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(worktree, '.env.example'), 'SECRET=');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  const policy = safeOvernightPreset(['npm test', 'npm run lint']);
  return {
    policy,
    mode: policy.mode,
    projectRoot,
    runWorktree: worktree,
    unattended: true,
    scratchDirs: [scratch],
    homeDir: home,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test('fixture corpus', () => {
  const ctx = makeCtx();
  try {
    const results = runFixtures(fixturesDir, ctx);
    assert.ok(results.length >= 150, `expected a large corpus, got ${results.length}`);
    const failures = results.filter((r) => !r.pass);
    const msg = failures
      .map((f) => `${path.basename(f.file)}#${f.index + 1} ${JSON.stringify(f.case.command ?? f.case.tool)} expected ${f.case.expect}${f.case.reason ? `/${f.case.reason}` : ''} got ${f.got.decision}/${f.got.reasonCode} (${f.got.rule}): ${f.got.reason}`)
      .join('\n');
    assert.equal(failures.length, 0, `fixture failures:\n${msg}`);
  } finally {
    ctx.cleanup();
  }
});

test('budget stops take precedence over allows but not over hard denies', () => {
  const ctx = makeCtx();
  try {
    const budget = { actionsUsed: 5, actionsLimit: 5, consecutiveDenials: 0, consecutiveDenialsLimit: 5 };
    const d = evaluate({ tool: 'Bash', input: { command: 'git status' }, cwd: ctx.runWorktree }, { ...ctx, budget });
    assert.equal(d.decision, 'deny');
    assert.equal(d.reasonCode, 'BUDGET_EXCEEDED');
    const hard = evaluate({ tool: 'Bash', input: { command: 'git push' }, cwd: ctx.runWorktree }, { ...ctx, budget });
    assert.equal(hard.reasonCode, 'PROD_RISK');
    const deadline = { actionsUsed: 0, actionsLimit: 100, consecutiveDenials: 0, consecutiveDenialsLimit: 5, deadline: '2020-01-01T00:00:00Z' };
    assert.equal(evaluate({ tool: 'Read', input: { file_path: 'README.md' }, cwd: ctx.runWorktree }, { ...ctx, budget: deadline }).reasonCode, 'BUDGET_EXCEEDED');
    const denials = { actionsUsed: 0, actionsLimit: 100, consecutiveDenials: 5, consecutiveDenialsLimit: 5 };
    assert.equal(evaluate({ tool: 'Read', input: { file_path: 'README.md' }, cwd: ctx.runWorktree }, { ...ctx, budget: denials }).rule, 'budget.denials');
    const spend = { actionsUsed: 0, actionsLimit: 100, consecutiveDenials: 0, consecutiveDenialsLimit: 5, spendUsd: 5.01, spendLimitUsd: 5 };
    assert.equal(evaluate({ tool: 'Read', input: { file_path: 'README.md' }, cwd: ctx.runWorktree }, { ...ctx, budget: spend }).rule, 'budget.spend');
  } finally {
    ctx.cleanup();
  }
});

test('symlinks out of the worktree are resolved before checking containment', () => {
  const ctx = makeCtx();
  try {
    const outside = path.join(ctx.projectRoot, 'outside');
    fs.mkdirSync(outside);
    try {
      fs.symlinkSync(outside, path.join(ctx.runWorktree, 'link'), 'dir');
    } catch {
      return; // no symlink privilege on this Windows runner
    }
    const d = evaluate({ tool: 'Write', input: { file_path: 'link/escape.txt', content: 'x' }, cwd: ctx.runWorktree }, ctx);
    assert.equal(d.reasonCode, 'OUTSIDE_WORKTREE');
    assert.match(d.reason, /symlink/);
  } finally {
    ctx.cleanup();
  }
});

test('scratch directories are writable', () => {
  const ctx = makeCtx();
  try {
    const scratch = ctx.scratchDirs![0].replace(/\\/g, '/');
    const d = evaluate({ tool: 'Bash', input: { command: `cp src/app.ts "${scratch}/a.ts"` }, cwd: ctx.runWorktree }, ctx);
    assert.equal(d.decision, 'allow', d.reason);
    const w = evaluate({ tool: 'Write', input: { file_path: path.join(scratch, 'x.txt'), content: '' }, cwd: ctx.runWorktree }, ctx);
    assert.equal(w.decision, 'allow');
  } finally {
    ctx.cleanup();
  }
});

test('configured roots reached through a symlink still match (macOS /etc, /tmp, $TMPDIR)', () => {
  const ctx = makeCtx();
  try {
    // Mirror the macOS layout: an allow root that is a symlink to a directory outside the project.
    const sys = path.join(ctx.projectRoot, '..', 'sys');
    fs.mkdirSync(path.join(sys, 'private', 'etc'), { recursive: true });
    fs.writeFileSync(path.join(sys, 'private', 'etc', 'hosts'), '127.0.0.1 localhost');
    try {
      fs.symlinkSync(path.join(sys, 'private', 'etc'), path.join(sys, 'etc'), 'dir');
    } catch {
      return; // symlinks need a privilege we may not have on Windows
    }
    const withRoot: PolicyContext = { ...ctx, policy: { ...ctx.policy, allow: { ...ctx.policy.allow, read_paths: [`${path.join(sys, 'etc')}/**`] } } };
    const read = evaluate({ tool: 'Read', input: { file_path: path.join(sys, 'etc', 'hosts') }, cwd: ctx.runWorktree }, withRoot);
    assert.equal(read.decision, 'allow', read.reason);

    // And a run worktree that is itself reached through a symlink.
    fs.symlinkSync(ctx.runWorktree, path.join(ctx.projectRoot, 'wtlink'), 'dir');
    const linked: PolicyContext = { ...ctx, runWorktree: path.join(ctx.projectRoot, 'wtlink') };
    const write = evaluate({ tool: 'Write', input: { file_path: path.join(ctx.projectRoot, 'wtlink', 'new.txt'), content: 'x' }, cwd: path.join(ctx.projectRoot, 'wtlink') }, linked);
    assert.equal(write.decision, 'allow', write.reason);
    // Protections must survive the symlink too.
    const secret = evaluate({ tool: 'Read', input: { file_path: path.join(ctx.projectRoot, 'wtlink', '.env') }, cwd: ctx.runWorktree }, linked);
    assert.equal(secret.reasonCode, 'SECRET_PATH');
    const tamper = evaluate({ tool: 'Write', input: { file_path: path.join(ctx.projectRoot, '.nightwatch', 'nightwatch.db'), content: 'x' }, cwd: ctx.runWorktree }, linked);
    assert.equal(tamper.reasonCode, 'SUPERVISOR_TAMPER');
    const outside = evaluate({ tool: 'Write', input: { file_path: path.join(sys, 'etc', 'hosts'), content: 'x' }, cwd: ctx.runWorktree }, withRoot);
    assert.equal(outside.reasonCode, 'OUTSIDE_WORKTREE', 'a read-only root is still not writable');
  } finally {
    ctx.cleanup();
  }
});

test('normalized call is redacted and never throws on odd input', () => {
  const ctx = makeCtx();
  try {
    const d = evaluate({ tool: 'Bash', input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" http://localhost:3000' }, cwd: ctx.runWorktree }, ctx);
    assert.ok(!d.normalized.summary.includes('abcdefghijklmnopqrstuvwxyz'));
    const weird = evaluate({ tool: 'Bash', input: { command: 12345 as unknown as string }, cwd: ctx.runWorktree }, ctx);
    assert.equal(weird.decision, 'deny');
    const nul = evaluate({ tool: 'Read', input: { file_path: 'a\0b' }, cwd: ctx.runWorktree }, ctx);
    assert.equal(nul.decision, 'deny');
    assert.equal(nul.reasonCode, 'PATH_UNRESOLVED');
  } finally {
    ctx.cleanup();
  }
});

test('guard mode confines writes to the project root and defers instead of denying when attended', () => {
  const ctx = makeCtx();
  try {
    const guard: PolicyContext = { ...ctx, mode: 'guard', runWorktree: ctx.projectRoot, unattended: false };
    const ok = evaluate({ tool: 'Write', input: { file_path: path.join(ctx.projectRoot, 'x.txt'), content: '' }, cwd: ctx.projectRoot }, guard);
    assert.equal(ok.decision, 'allow');
    const unknown = evaluate({ tool: 'Bash', input: { command: 'node scripts/x.js' }, cwd: ctx.projectRoot }, guard);
    assert.equal(unknown.decision, 'defer');
  } finally {
    ctx.cleanup();
  }
});
