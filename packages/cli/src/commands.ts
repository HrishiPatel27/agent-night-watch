import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  NightwatchStore,
  PROFILES,
  PreflightFailed,
  defaultConfigYaml,
  deleteBranch,
  detectProject,
  ensureExcluded,
  findExecutable,
  git,
  isAlive,
  killTree,
  listAgentIds,
  locateAgent,
  openInBrowser,
  removeWorktree,
  runSession,
  spawnDetachedSelf,
  type RunResult,
} from '@nightwatch-agent/daemon';
import { handleHook } from '@nightwatch-agent/hook';
import { PRESETS, evaluate, loadPolicyFile, parsePolicy, policyToYaml, runFixtures, safeOvernightPreset, PolicyError } from '@nightwatch-agent/policy';
import { buildReportModel, renderHtml, renderMarkdown, renderTerminal, summaryLine } from '@nightwatch-agent/report';
import { formatUsd, nightwatchPaths, runPaths, VERSION, type Mode, type PolicyContext } from '@nightwatch-agent/shared';
import { installProjectHooks, uninstallProjectHooks } from './hooks-install.js';
import { CliError, ago, loadPolicyFor, out, pad, resolveHookCommand, resolveProject } from './util.js';

export type Flags = Record<string, string | boolean | undefined>;

const str = (f: Flags, k: string): string | undefined => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
const num = (f: Flags, k: string): number | undefined => {
  const v = str(f, k);
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CliError(`--${k} must be a number`);
  return n;
};
const bool = (f: Flags, k: string): boolean => f[k] === true;

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export async function cmdInit(flags: Flags): Promise<void> {
  const p = resolveProject(str(flags, 'project'), { requireInit: false });
  const presetName = str(flags, 'preset') ?? 'safe-overnight';
  const preset = PRESETS[presetName];
  if (!preset) throw new CliError(`unknown preset "${presetName}" (available: ${Object.keys(PRESETS).join(', ')})`);
  const agent = str(flags, 'agent') ?? 'claude-code';
  if (!PROFILES[agent] && !p.config.agents[agent]) throw new CliError(`unknown agent "${agent}" (available: ${Object.keys(PROFILES).join(', ')})`);
  fs.mkdirSync(p.paths.runs, { recursive: true });
  const detection = detectProject(p.root);
  if (fs.existsSync(p.paths.policy) && !bool(flags, 'force')) {
    out.warn(`${path.relative(p.root, p.paths.policy)} already exists (use --force to overwrite)`);
  } else {
    const policy = preset(detection.allowCommands, detection.testCommand ?? undefined);
    fs.writeFileSync(p.paths.policy, policyToYaml(policy));
    out.ok(`Wrote ${path.relative(p.root, p.paths.policy)} (${policy.name} preset, ${policy.allow.commands.length} allowed commands from ${detection.language.join('/') || 'no detected toolchain'})`);
  }
  if (fs.existsSync(p.paths.config) && !bool(flags, 'force')) {
    out.warn(`${path.relative(p.root, p.paths.config)} already exists (use --force to overwrite)`);
  } else {
    fs.writeFileSync(p.paths.config, defaultConfigYaml(agent, detection.testCommand));
    out.ok(`Wrote ${path.relative(p.root, p.paths.config)} (default agent: ${agent})`);
  }
  if (ensureExcluded(p.root, '.nightwatch/')) out.ok('Added .nightwatch/ to .git/info/exclude');
  for (const n of detection.notes) out.warn(n);
  if (bool(flags, 'hooks')) {
    const r = installProjectHooks(agent, p.root, resolveHookCommand());
    out.ok(`Hooks ${r.action}: ${path.relative(p.root, r.file)}${r.note ? ` (${r.note})` : ''}`);
    out.info('  Interactive sessions in this project are now guarded (unknown commands ask instead of block).');
  }
  const bin = locateAgent(agent, p.config);
  if (bin) out.ok(`${PROFILES[agent]?.displayName ?? agent} found: ${bin}`);
  else out.warn(`${PROFILES[agent]?.displayName ?? agent} binary not found on PATH; install it before running`);
  out.info('');
  out.info('Next: review .nightwatch/policy.yaml, then start a guarded run, for example:');
  out.info('  nightwatch run --hours 8 --budget-usd 5 --task "Exercise the app, reproduce failures, and propose fixes"');
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export async function cmdRun(flags: Flags, positionals: string[]): Promise<void> {
  const p = resolveProject(str(flags, 'project'));
  const task = str(flags, 'task') ?? positionals.join(' ').trim();
  if (!task) throw new CliError('a task is required: nightwatch run --task "…"');
  const mode = str(flags, 'mode') as Mode | undefined;
  if (mode && !['observe', 'guard', 'quarantine'].includes(mode)) throw new CliError('--mode must be observe, guard or quarantine');
  const loaded = loadPolicyFor(p, str(flags, 'policy'));
  for (const w of loaded.warnings) out.warn(`policy: ${w}`);
  const agentId = str(flags, 'agent') ?? p.config.agent;
  const hook = resolveHookCommand();

  if (bool(flags, 'detach') && !bool(flags, '_child')) {
    const args = process.argv.slice(2).filter((a) => a !== '--detach' && a !== '-d');
    args.push('--_child');
    const logFile = path.join(p.paths.logs, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    const pid = spawnDetachedSelf(args, logFile);
    out.ok(`Run started in the background (pid ${pid}). Log: ${logFile}`);
    const store = new NightwatchStore(p.paths.db);
    try {
      const deadline = Date.now() + 30_000;
      let found = null;
      while (Date.now() < deadline) {
        found = store.listSessions(5).find((s) => s.pid === pid);
        if (found && found.status === 'running') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (found) {
        out.ok(`Session ${found.id}${found.port ? ` · dashboard http://127.0.0.1:${found.port}` : ''}`);
        out.info(`  nightwatch status · nightwatch stop ${found.id} · nightwatch report ${found.id}`);
      } else out.warn('Session did not report in within 30s; check the log file.');
    } finally {
      store.close();
    }
    return;
  }

  let result: RunResult;
  try {
    result = await runSession({
      projectRoot: p.root,
      task,
      hours: num(flags, 'hours'),
      budgetUsd: num(flags, 'budget-usd'),
      mode,
      agentId,
      policy: loaded.policy,
      policyYaml: loaded.yaml,
      policyWarnings: loaded.warnings,
      config: p.config,
      hook,
      dashboard: flags['no-dashboard'] ? false : undefined,
      port: num(flags, 'port'),
      maxTurns: num(flags, 'max-turns'),
      model: str(flags, 'model'),
      force: bool(flags, 'force'),
      dryRun: bool(flags, 'dry-run'),
      render: (store, sid, live) => renderHtml(buildReportModel(store, sid, { previews: !live }), live ? { live } : {}),
      reportModel: (store, sid) => buildReportModel(store, sid, { previews: false }),
      log: (line) => out.info(line),
    });
  } catch (err) {
    if (err instanceof PreflightFailed) throw new CliError('Preflight failed. Fix the items marked ✗ above (or pass --force to run anyway).', 2);
    throw err;
  }
  if (bool(flags, 'dry-run')) {
    out.ok('Dry run: preflight passed, nothing was started.');
    return;
  }
  out.info('');
  const store = new NightwatchStore(p.paths.db);
  try {
    const model = buildReportModel(store, result.sessionId, { previews: false });
    out.info(renderTerminal(model));
  } finally {
    store.close();
  }
  out.info('');
  out.ok(`Report: ${result.reportFile}`);
  if (result.patchFile && fs.existsSync(result.patchFile)) out.ok(`Patch:  ${result.patchFile}`);
  out.info(`Next: nightwatch report ${result.sessionId} --open · nightwatch clean ${result.sessionId}`);
  if (bool(flags, 'open') || p.config.open_report) openInBrowser(result.reportFile);
  if (result.status === 'failed') process.exitCode = 3;
}

// ---------------------------------------------------------------------------
// status / stop
// ---------------------------------------------------------------------------

export async function cmdStatus(flags: Flags): Promise<void> {
  const p = resolveProject(str(flags, 'project'));
  if (!fs.existsSync(p.paths.db)) {
    out.info('No runs yet.');
    return;
  }
  const store = new NightwatchStore(p.paths.db);
  try {
    for (const s of store.activeSessions()) {
      if (s.pid && !isAlive(s.pid)) store.setStatus(s.id, 'interrupted', 'runner process is no longer alive');
    }
    const sessions = store.listSessions(Number(str(flags, 'limit') ?? 10));
    if (bool(flags, 'json')) {
      out.json(sessions.map((s) => ({ ...s, actions: store.countActions(s.id), decisions: store.countByDecision(s.id) })));
      return;
    }
    if (!sessions.length) {
      out.info('No runs yet.');
      return;
    }
    out.info(`${pad('RUN', 26)} ${pad('STATUS', 12)} ${pad('AGENT', 12)} ${pad('STARTED', 12)} ${pad('ACTIONS', 20)} ${pad('COST', 8)} TASK`);
    for (const s of sessions) {
      const d = store.countByDecision(s.id);
      const actions = `${store.countActions(s.id)} (${d.deny ?? 0} denied)`;
      out.info(`${pad(s.id, 26)} ${pad(s.status, 12)} ${pad(s.agent, 12)} ${pad(ago(s.started_at), 12)} ${pad(actions, 20)} ${pad(formatUsd(s.cost_usd), 8)} ${s.task.slice(0, 50)}`);
      if (s.status === 'running' && s.port) out.info(`${' '.repeat(27)}dashboard: http://127.0.0.1:${s.port}`);
      if (s.status === 'interrupted') out.info(`${' '.repeat(27)}interrupted: nightwatch report ${s.id} · nightwatch clean ${s.id}`);
    }
  } finally {
    store.close();
  }
}

export async function cmdStop(flags: Flags, positionals: string[]): Promise<void> {
  const p = resolveProject(str(flags, 'project'));
  const store = new NightwatchStore(p.paths.db);
  try {
    const target = positionals[0] ? store.resolveSession(positionals[0]) : store.activeSessions()[0] ?? null;
    if (!target) throw new CliError(positionals[0] ? `session ${positionals[0]} not found` : 'no active session');
    if (!['running', 'preflight', 'stopping'].includes(target.status)) throw new CliError(`session ${target.id} is ${target.status}`);
    store.requestStop(target.id, 'stopped by nightwatch stop');
    out.info(`Stop requested for ${target.id}; waiting for the runner…`);
    const deadline = Date.now() + (bool(flags, 'force') ? 5_000 : 30_000);
    while (Date.now() < deadline) {
      const s = store.getSession(target.id)!;
      if (!['running', 'preflight', 'stopping'].includes(s.status)) {
        out.ok(`Session ${s.id} ${s.status}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const s = store.getSession(target.id)!;
    if (s.pid && isAlive(s.pid)) {
      if (!bool(flags, 'force')) throw new CliError(`runner (pid ${s.pid}) has not stopped yet; re-run with --force to kill it`);
      await killTree(s.pid);
      store.setStatus(target.id, 'interrupted', 'killed by nightwatch stop --force');
      out.warn(`Killed runner pid ${s.pid}; the run is marked interrupted. Generate a report with: nightwatch report ${s.id}`);
    } else {
      store.setStatus(target.id, 'interrupted', 'runner process was not alive');
      out.warn('Runner process was already gone; the run is marked interrupted.');
    }
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// report / clean / purge
// ---------------------------------------------------------------------------

export async function cmdReport(flags: Flags, positionals: string[]): Promise<void> {
  const p = resolveProject(str(flags, 'project'));
  if (!fs.existsSync(p.paths.db)) throw new CliError('no runs yet');
  const store = new NightwatchStore(p.paths.db);
  try {
    const s = store.resolveSession(positionals[0] ?? 'latest');
    if (!s) throw new CliError(`session ${positionals[0] ?? 'latest'} not found`);
    const model = buildReportModel(store, s.id);
    const rp = runPaths(p.root, s.id);
    if (bool(flags, 'json')) {
      out.json(model);
      return;
    }
    if (bool(flags, 'md')) {
      const md = renderMarkdown(model);
      if (str(flags, 'out')) fs.writeFileSync(str(flags, 'out')!, md);
      else process.stdout.write(md);
      return;
    }
    const html = renderHtml(model);
    const file = str(flags, 'out') ?? rp.report;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
    out.info(renderTerminal(model));
    out.info('');
    out.ok(`HTML report: ${file}`);
    if (bool(flags, 'open')) openInBrowser(file);
  } finally {
    store.close();
  }
}

export async function cmdClean(flags: Flags, positionals: string[]): Promise<void> {
  const p = resolveProject(str(flags, 'project'));
  if (bool(flags, 'prune')) {
    git(['worktree', 'prune'], p.root, { allowFail: true });
    out.ok('Pruned stale worktree entries');
  }
  if (!fs.existsSync(p.paths.db)) return;
  const store = new NightwatchStore(p.paths.db);
  try {
    let targets = [] as ReturnType<typeof store.listSessions>;
    if (bool(flags, 'all-finished')) targets = store.listSessions(1000).filter((s) => !['running', 'preflight', 'stopping'].includes(s.status));
    else if (positionals[0]) {
      const s = store.resolveSession(positionals[0]);
      if (!s) throw new CliError(`session ${positionals[0]} not found`);
      targets = [s];
    } else if (!bool(flags, 'prune')) throw new CliError('specify a run id, "latest", or --all-finished');
    for (const s of targets) {
      if (['running', 'preflight', 'stopping'].includes(s.status) && !(s.pid && !isAlive(s.pid))) throw new CliError(`session ${s.id} is ${s.status}; stop it first`);
      const rp = runPaths(p.root, s.id);
      if (s.mode === 'quarantine' && fs.existsSync(s.worktree)) {
        removeWorktree(p.root, s.worktree);
        out.ok(`Removed worktree ${path.relative(p.root, s.worktree)}`);
      }
      if (s.branch && !bool(flags, 'keep-branch')) {
        if (deleteBranch(p.root, s.branch)) out.ok(`Deleted branch ${s.branch}`);
      }
      if (bool(flags, 'purge')) {
        fs.rmSync(rp.base, { recursive: true, force: true });
        store.deleteSession(s.id);
        out.ok(`Purged run directory and event log for ${s.id}`);
      } else {
        out.info(`Kept report, patch and event log for ${s.id} (use --purge to delete them)`);
      }
    }
    git(['worktree', 'prune'], p.root, { allowFail: true });
  } finally {
    store.close();
  }
}

export async function cmdPurge(flags: Flags): Promise<void> {
  const p = resolveProject(str(flags, 'project'));
  if (!bool(flags, 'yes')) throw new CliError('this deletes every recorded run, event and report in .nightwatch/. Re-run with --yes to confirm.');
  if (fs.existsSync(p.paths.db)) {
    const store = new NightwatchStore(p.paths.db);
    try {
      if (store.activeSessions().some((s) => s.pid && isAlive(s.pid))) throw new CliError('a run is still active; stop it first');
      for (const s of store.listSessions(10_000)) {
        if (s.mode === 'quarantine' && fs.existsSync(s.worktree)) removeWorktree(p.root, s.worktree);
        if (s.branch) deleteBranch(p.root, s.branch);
      }
      store.purgeAll();
    } finally {
      store.close();
    }
  }
  fs.rmSync(p.paths.runs, { recursive: true, force: true });
  fs.rmSync(p.paths.logs, { recursive: true, force: true });
  for (const f of fs.existsSync(p.paths.dir) ? fs.readdirSync(p.paths.dir) : []) {
    if (/^nightwatch\.db(-wal|-shm)?$/.test(f)) fs.rmSync(path.join(p.paths.dir, f), { force: true });
  }
  git(['worktree', 'prune'], p.root, { allowFail: true });
  out.ok('Purged all Nightwatch runs, logs and reports (policy.yaml and config.yaml were kept)');
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

export async function cmdPolicy(flags: Flags, positionals: string[]): Promise<void> {
  const sub = positionals[0];
  const p = resolveProject(str(flags, 'project'), { requireInit: false });
  if (sub === 'validate') {
    const file = positionals[1] ?? p.paths.policy;
    try {
      const l = loadPolicyFile(file);
      for (const w of l.warnings) out.warn(w);
      out.ok(`${file} is valid (${l.policy.name}, mode ${l.policy.mode})`);
    } catch (err) {
      if (err instanceof PolicyError) throw new CliError(err.message, 2);
      throw err;
    }
    return;
  }
  if (sub === 'show') {
    const l = loadPolicyFor(p, str(flags, 'policy'));
    process.stdout.write(policyToYaml(l.policy));
    return;
  }
  if (sub === 'check') {
    const l = loadPolicyFor(p, str(flags, 'policy'));
    const tool = str(flags, 'tool') ?? 'Bash';
    const command = positionals.slice(1).join(' ');
    let input: Record<string, unknown>;
    if (str(flags, 'input')) input = JSON.parse(str(flags, 'input')!) as Record<string, unknown>;
    else if (tool === 'Bash') input = { command };
    else if (['Read', 'Write', 'Edit'].includes(tool)) input = { file_path: command };
    else if (tool === 'WebFetch') input = { url: command };
    else input = {};
    const worktree = str(flags, 'worktree') ?? p.root;
    const ctx: PolicyContext = {
      policy: l.policy,
      mode: (str(flags, 'mode') as Mode | undefined) ?? l.policy.mode,
      projectRoot: p.root,
      runWorktree: worktree,
      unattended: !bool(flags, 'attended'),
    };
    const d = evaluate({ tool, input, cwd: str(flags, 'cwd') ?? worktree }, ctx);
    if (bool(flags, 'json')) {
      out.json(d);
    } else {
      const glyph = d.decision === 'allow' ? '✓' : d.decision === 'deny' ? '✗' : '?';
      out.info(`${glyph} ${d.decision.toUpperCase()}  ${d.reasonCode}  (${d.rule ?? 'no rule'})`);
      out.info(`  ${d.reason}`);
      if (d.normalized.commands.length) out.info(`  commands: ${d.normalized.commands.join(' | ')}`);
      if (d.normalized.paths.length) out.info(`  paths: ${d.normalized.paths.join(', ')}`);
      if (d.normalized.hosts.length) out.info(`  hosts: ${d.normalized.hosts.join(', ')}`);
    }
    process.exitCode = d.decision === 'allow' ? 0 : d.decision === 'defer' ? 1 : 2;
    return;
  }
  if (sub === 'fixtures') {
    const dir = positionals[1] ?? findFixturesDir();
    if (!dir || !fs.existsSync(dir)) throw new CliError('fixtures directory not found; pass a path');
    // The corpus is written against the pristine safe-overnight preset (+ the two commands it references).
    const policy = str(flags, 'policy') ? loadPolicyFor(p, str(flags, 'policy')).policy : safeOvernightPreset(['npm test', 'npm run lint']);
    fs.mkdirSync(p.paths.dir, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(p.paths.dir, 'fixtures-'));
    const worktree = path.join(tmp, 'worktree');
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
    for (const f of ['src/app.ts', 'src/index.ts', 'package.json', 'README.md', '.env', '.env.example']) fs.writeFileSync(path.join(worktree, f), '');
    try {
      const results = runFixtures(dir, { policy, mode: policy.mode, projectRoot: p.root, runWorktree: worktree, unattended: true, scratchDirs: [path.join(tmp, 'scratch')] });
      const failed = results.filter((r) => !r.pass);
      for (const r of failed) out.fail(`${path.basename(r.file)}#${r.index + 1} ${r.case.command ?? r.case.tool}: expected ${r.case.expect}${r.case.reason ? `/${r.case.reason}` : ''}, got ${r.got.decision}/${r.got.reasonCode} (${r.got.rule})`);
      out.info(`${results.length - failed.length}/${results.length} fixtures passed`);
      process.exitCode = failed.length ? 1 : 0;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }
  throw new CliError('usage: nightwatch policy <check|validate|show|fixtures> …');
}

function findFixturesDir(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'fixtures', 'commands');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

// ---------------------------------------------------------------------------
// hooks / hook / doctor / agents
// ---------------------------------------------------------------------------

export async function cmdHooks(flags: Flags, positionals: string[]): Promise<void> {
  const p = resolveProject(str(flags, 'project'));
  const agent = str(flags, 'agent') ?? p.config.agent;
  const sub = positionals[0];
  if (sub === 'install') {
    const r = installProjectHooks(agent, p.root, resolveHookCommand());
    out.ok(`Hooks ${r.action}: ${r.file}${r.note ? ` (${r.note})` : ''}`);
    return;
  }
  if (sub === 'uninstall') {
    const r = uninstallProjectHooks(agent, p.root);
    out.ok(`Hooks ${r.action}: ${r.file}`);
    return;
  }
  throw new CliError('usage: nightwatch hooks <install|uninstall> [--agent <id>]');
}

export async function cmdHook(positionals: string[]): Promise<void> {
  const stdin = await new Promise<string>((resolve) => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => resolve(d));
    setTimeout(() => resolve(d), 10_000);
  });
  const r = handleHook(positionals[0] ?? 'auto', stdin);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(`${r.stderr}\n`);
  process.exitCode = r.exitCode;
}

export async function cmdDoctor(flags: Flags): Promise<void> {
  const p = resolveProject(str(flags, 'project'), { requireInit: false });
  const agents = str(flags, 'agent') ? [str(flags, 'agent')!] : listAgentIds(p.config);
  out.info(`Nightwatch ${VERSION} · Node ${process.versions.node} · ${process.platform}/${process.arch}`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) out.ok('Node 22.13+ with built-in SQLite');
  else out.fail(`Node ${process.versions.node} is too old; install Node 22.13+`);
  try {
    out.ok(`Git: ${execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()}`);
  } catch {
    out.fail('git not found on PATH');
  }
  const hook = resolveHookCommand();
  try {
    execFileSync(hook.node, [hook.script, '--selftest'], { encoding: 'utf8' });
    out.ok(`Hook adapter: ${hook.script}`);
  } catch (err) {
    out.fail(`Hook adapter self-test failed: ${(err as Error).message}`);
  }
  if (process.platform === 'win32') {
    const bash = findExecutable('bash');
    if (bash) out.ok(`Git Bash: ${bash}`);
    else out.warn('bash.exe not found; Claude Code will run hooks through PowerShell. Set hooks_exec_form: true in .nightwatch/config.yaml');
  }
  out.info('');
  out.info('Agents:');
  for (const id of agents) {
    const profile = PROFILES[id];
    const bin = locateAgent(id, p.config);
    const label = profile ? `${profile.displayName}${profile.experimental ? ' (experimental)' : ''}` : `${id} (custom)`;
    if (bin) out.ok(`${pad(id, 13)} ${label} → ${bin}`);
    else out.warn(`${pad(id, 13)} ${label} → not found on PATH`);
  }
  if (fs.existsSync(p.paths.policy)) {
    try {
      const l = loadPolicyFile(p.paths.policy);
      out.ok(`Policy: ${l.policy.name} (${l.warnings.length ? l.warnings.join('; ') : 'no warnings'})`);
    } catch (err) {
      out.fail(`Policy: ${(err as Error).message}`);
    }
  } else out.warn('No policy.yaml; run "nightwatch init"');
}

export async function cmdAgents(flags: Flags): Promise<void> {
  const p = resolveProject(str(flags, 'project'), { requireInit: false });
  out.info(`${pad('ID', 13)} ${pad('NAME', 24)} ${pad('HOOKS', 34)} STATUS`);
  const hooksFor: Record<string, string> = {
    'claude-code': 'PreToolUse via --settings (no repo writes)',
    codex: '.codex/hooks.json in worktree',
    'gemini-cli': '.gemini/settings.json in worktree',
    'copilot-cli': '.github/hooks/nightwatch.json in worktree',
    cursor: '.cursor/hooks.json in worktree',
    grok: '.grok/hooks/nightwatch.json in worktree',
    opencode: '.opencode/plugins plugin in worktree',
    amp: 'permission delegate via --settings-file',
    aider: 'none (PATH shims + worktree only)',
  };
  for (const id of listAgentIds(p.config)) {
    const profile = PROFILES[id];
    const bin = locateAgent(id, p.config);
    out.info(`${pad(id, 13)} ${pad(profile?.displayName ?? `${id} (custom)`, 24)} ${pad(hooksFor[id] ?? 'custom template', 34)} ${bin ? `installed (${bin})` : 'not found'}${profile?.experimental ? ' · experimental' : ''}`);
  }
}

export function pathsFor(root: string) {
  return nightwatchPaths(root);
}

export { parsePolicy };
