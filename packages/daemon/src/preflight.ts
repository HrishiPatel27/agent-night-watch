import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { nightwatchPaths, type Policy } from '@nightwatch-agent/shared';
import type { NightwatchConfig } from './config.js';
import { gitVersion, hasCommits, isDirty, isGitRepo, listWorktrees } from './git.js';
import { findExecutable, isAlive } from './process.js';
import { PROFILES, resolveProfile } from './agents.js';
import type { NightwatchStore } from './store.js';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface PreflightResult {
  checks: Check[];
  ok: boolean;
  port: number | null;
  agentBinary: string | null;
  interrupted: string[];
}

export async function findFreePort(preferred: number, attempts = 20): Promise<number | null> {
  for (let p = preferred; p < preferred + attempts; p++) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) return p;
  }
  return null;
}

export interface PreflightOptions {
  projectRoot: string;
  policy: Policy;
  policyWarnings: string[];
  config: NightwatchConfig;
  agentId: string;
  hookScript: string;
  store: NightwatchStore;
  wantDashboard: boolean;
  port?: number;
}

export async function runPreflight(o: PreflightOptions): Promise<PreflightResult> {
  const checks: Check[] = [];
  const push = (name: string, status: Check['status'], detail: string) => checks.push({ name, status, detail });

  // Node
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) push('Node.js', 'ok', `v${process.versions.node}`);
  else push('Node.js', 'fail', `v${process.versions.node}; Nightwatch needs Node 22.13+ (built-in SQLite)`);

  // Git
  const gv = gitVersion();
  if (!gv) push('Git', 'fail', 'git is not on PATH');
  else push('Git', 'ok', gv);
  if (!isGitRepo(o.projectRoot)) push('Repository', 'fail', `${o.projectRoot} is not a git repository`);
  else if (!hasCommits(o.projectRoot)) push('Repository', 'fail', 'repository has no commits yet; make an initial commit first');
  else {
    push('Repository', 'ok', o.projectRoot);
    if (isDirty(o.projectRoot)) push('Working tree', 'warn', 'uncommitted changes in the main tree will not be visible to the run (the worktree starts from HEAD)');
    else push('Working tree', 'ok', 'clean');
  }

  // Agent binary
  const profile = resolveProfile(o.agentId, o.config);
  let agentBinary: string | null = null;
  if (!profile) push('Agent', 'fail', `unknown agent "${o.agentId}" (known: ${Object.keys(PROFILES).join(', ')}, or define it in config.yaml)`);
  else {
    const override = o.config.agents[o.agentId]?.command;
    const candidates = override ? [override] : profile.binaries;
    for (const c of candidates) {
      agentBinary = findExecutable(c);
      if (agentBinary) break;
    }
    if (agentBinary) push('Agent', profile.experimental ? 'warn' : 'ok', `${profile.displayName}: ${agentBinary}${profile.experimental ? ' (experimental integration)' : ''}`);
    else push('Agent', 'fail', `${profile.displayName} binary not found on PATH (tried ${candidates.join(', ')})`);
  }

  // Hook script
  if (fs.existsSync(o.hookScript)) push('Hook adapter', 'ok', o.hookScript);
  else push('Hook adapter', 'fail', `hook script missing: ${o.hookScript}`);
  if (process.platform === 'win32' && o.agentId === 'claude-code' && !o.config.hooks_exec_form) {
    const bash = findExecutable('bash');
    if (bash) push('Git Bash', 'ok', bash);
    else push('Git Bash', 'warn', 'bash.exe not found; Claude Code runs hooks through PowerShell there. Set hooks_exec_form: true in config.yaml');
  }

  // Policy
  push('Policy', o.policyWarnings.length ? 'warn' : 'ok', `${o.policy.name} (mode ${o.policy.mode}, ${o.policy.allow.commands.length} allowed commands)${o.policyWarnings.length ? `: ${o.policyWarnings.join('; ')}` : ''}`);
  if (o.policy.mode === 'observe') push('Mode', 'warn', 'observe mode records but never blocks');
  if (o.policy.unknown_commands === 'allow') push('Unknown commands', 'warn', 'allowed by policy; only hard-deny rules apply');
  if (!o.policy.test_command && !o.config.test_command) push('Test command', 'warn', 'none configured; test results will not be parsed');
  else push('Test command', 'ok', o.policy.test_command ?? o.config.test_command ?? '');

  // Storage
  const paths = nightwatchPaths(o.projectRoot);
  try {
    fs.mkdirSync(paths.runs, { recursive: true });
    fs.accessSync(paths.dir, fs.constants.W_OK);
    push('Storage', 'ok', paths.db);
  } catch (err) {
    push('Storage', 'fail', `${paths.dir} is not writable: ${(err as Error).message}`);
  }

  // Existing sessions
  const active = o.store.activeSessions();
  const interrupted: string[] = [];
  for (const s of active) {
    if (s.pid && isAlive(s.pid)) push('Active session', 'fail', `session ${s.id} is still running (pid ${s.pid}); stop it first with "nightwatch stop ${s.id}"`);
    else {
      o.store.setStatus(s.id, 'interrupted', 'runner process no longer alive at next launch');
      interrupted.push(s.id);
    }
  }
  if (interrupted.length) push('Interrupted sessions', 'warn', `${interrupted.join(', ')} ended without cleanup; run "nightwatch report <id>" or "nightwatch clean <id>"`);
  const orphans = listWorktrees(o.projectRoot).filter((w) => w.branch?.startsWith('nightwatch/') && !fs.existsSync(w.path));
  if (orphans.length) push('Worktrees', 'warn', `${orphans.length} stale worktree entries; "nightwatch clean --prune" removes them`);

  // Port
  let port: number | null = null;
  if (o.wantDashboard) {
    port = await findFreePort(o.port ?? o.config.dashboard_port);
    if (port) push('Dashboard port', 'ok', `127.0.0.1:${port}`);
    else push('Dashboard port', 'warn', `no free port near ${o.port ?? o.config.dashboard_port}; dashboard disabled`);
  }

  return { checks, ok: !checks.some((c) => c.status === 'fail'), port, agentBinary, interrupted };
}

export function coverageSummary(covered: string[], uncovered: string[]): string {
  return `Guarded surfaces: ${covered.join(', ')}.\nNot covered: ${uncovered.join('; ')}.`;
}

export { path };
