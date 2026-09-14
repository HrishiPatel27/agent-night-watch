import { spawn, execSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { FINDINGS_FILE, newSessionId, nowIso, redactText, runPaths, type Mode, type Policy, type PolicyContext, type SessionRecord } from '@nightwatch-agent/shared';
import { policyToYaml } from '@nightwatch-agent/policy';
import { buildInstructions, planLaunch, resolveProfile, restoreEphemeralFiles, writeEphemeralFiles, type HookCommand, type LaunchPlan, type WrittenFile } from './agents.js';
import { stopReason } from './budget.js';
import { estimateCostUsd, type NightwatchConfig } from './config.js';
import { changedFiles, commitLog, createWorktree, ensureExcluded, exportPatch, fingerprintTree, headSha } from './git.js';
import { findExecutable, killTree } from './process.js';
import { createShims, shimEnv } from './shims.js';
import { startServer, type RunningServer } from './server.js';
import { parseStreamLine } from './stream.js';
import { NightwatchStore } from './store.js';
import { runPreflight, type PreflightResult } from './preflight.js';

export interface RunOptions {
  projectRoot: string;
  task: string;
  hours?: number;
  budgetUsd?: number;
  mode?: Mode;
  agentId?: string;
  policy: Policy;
  policyYaml: string;
  policyWarnings: string[];
  config: NightwatchConfig;
  hook: HookCommand;
  dashboard?: boolean;
  port?: number;
  maxTurns?: number;
  model?: string;
  /** Renders the HTML report (injected by the CLI so the daemon does not depend on the report package). */
  render: (store: NightwatchStore, sessionId: string, live?: { token: string }) => string;
  reportModel: (store: NightwatchStore, sessionId: string) => unknown;
  log: (line: string) => void;
  /** Called once the agent is running (id, dashboard URL). */
  onStarted?: (info: { sessionId: string; dashboardUrl: string | null; worktree: string; plan: LaunchPlan }) => void;
  /** Skip preflight failures (not recommended). */
  force?: boolean;
  dryRun?: boolean;
}

export interface RunResult {
  sessionId: string;
  status: SessionRecord['status'];
  stopReason: string | null;
  worktree: string;
  branch: string;
  reportFile: string;
  patchFile: string;
  preflight: PreflightResult;
  exitCode: number | null;
}

class PreflightFailed extends Error {
  constructor(public readonly result: PreflightResult) {
    super('preflight failed');
  }
}

export { PreflightFailed };

/** Orchestrates one guarded run from preflight to report. */
export async function runSession(o: RunOptions): Promise<RunResult> {
  const store = new NightwatchStore(path.join(o.projectRoot, '.nightwatch', 'nightwatch.db'));
  const policy: Policy = { ...o.policy, mode: o.mode ?? o.policy.mode };
  if (o.hours) policy.limits = { ...policy.limits, wall_time_minutes: Math.round(o.hours * 60) };
  if (o.budgetUsd != null) policy.limits = { ...policy.limits, budget_usd: o.budgetUsd };
  const agentId = o.agentId ?? o.config.agent;
  const wantDashboard = o.dashboard ?? o.config.dashboard;

  const preflight = await runPreflight({
    projectRoot: o.projectRoot,
    policy,
    policyWarnings: o.policyWarnings,
    config: o.config,
    agentId,
    hookScript: o.hook.script,
    store,
    wantDashboard,
    port: o.port,
  });
  for (const c of preflight.checks) o.log(`${c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'} ${c.name}: ${c.detail}`);
  if (!preflight.ok && !o.force) {
    store.close();
    throw new PreflightFailed(preflight);
  }
  if (o.dryRun) {
    store.close();
    return { sessionId: '', status: 'completed', stopReason: 'dry run', worktree: '', branch: '', reportFile: '', patchFile: '', preflight, exitCode: null };
  }

  ensureExcluded(o.projectRoot, '.nightwatch/');
  const id = newSessionId();
  const rp = runPaths(o.projectRoot, id);
  fs.mkdirSync(rp.base, { recursive: true });
  const branch = `nightwatch/${id}`;
  const baseRef = headSha(o.projectRoot);
  const mainFingerprint = fingerprintTree(o.projectRoot);
  const quarantine = policy.mode === 'quarantine';
  const worktree = quarantine ? rp.worktree : o.projectRoot;

  const session = store.createSession({
    id,
    project_root: o.projectRoot,
    worktree,
    branch: quarantine ? branch : null,
    base_ref: baseRef,
    mode: policy.mode,
    agent: agentId,
    task: o.task,
    policy_name: policy.name,
    policy_version: String(policy.version),
    policy_yaml: policyToYaml(policy, false),
    unattended: true,
    limits: { ...policy.limits },
  });
  store.updateSession(id, { main_tree_fingerprint: mainFingerprint, pid: process.pid, port: preflight.port });
  const runLog = (line: string) => {
    const text = `[${nowIso()}] ${line}`;
    o.log(line);
    try {
      fs.appendFileSync(rp.log, `${text}\n`);
    } catch {
      /* ignore */
    }
  };

  let written: WrittenFile[] = [];
  let server: RunningServer | null = null;
  let child: ChildProcess | null = null;
  let finalStop: string | null = null;
  let exitCode: number | null = null;
  let stopping = false;

  const policyContext = (): PolicyContext => ({ policy, mode: policy.mode, projectRoot: o.projectRoot, runWorktree: worktree, unattended: true });

  try {
    // 1. Isolation
    if (quarantine) {
      createWorktree(o.projectRoot, worktree, branch, baseRef);
      runLog(`Created isolated worktree: ${path.relative(o.projectRoot, worktree)} (branch ${branch})`);
      linkDependencies(o.projectRoot, worktree, o.config.link_dependencies, runLog);
      if (o.config.setup_command) {
        runLog(`Running setup command: ${o.config.setup_command}`);
        try {
          execSync(o.config.setup_command, { cwd: worktree, stdio: 'inherit', timeout: 30 * 60_000 });
        } catch (err) {
          throw new Error(`setup_command failed: ${(err as Error).message}`);
        }
      }
    } else {
      runLog(`Mode ${policy.mode}: running in the main tree ${worktree}`);
    }
    store.insertTranscript(id, 'runner', `worktree=${worktree} branch=${quarantine ? branch : '(none)'} base=${baseRef}`);

    // 2. Launch plan
    const hours = policy.limits.wall_time_minutes / 60;
    const plan = planLaunch(
      {
        agentId,
        task: o.task,
        instructions: buildInstructions({ worktree, branch: quarantine ? branch : null, hours: Math.round(hours * 10) / 10, budgetUsd: policy.limits.budget_usd, policyName: policy.name, agentName: agentId, unknownCommands: policy.unknown_commands }),
        worktree,
        runDir: rp.base,
        projectRoot: o.projectRoot,
        hook: o.hook,
        config: o.config,
        policy,
        budgetUsd: policy.limits.budget_usd,
        maxTurns: o.maxTurns,
        model: o.model,
      },
      preflight.agentBinary ?? resolveProfile(agentId, o.config)?.binaries[0] ?? agentId,
    );
    written = writeEphemeralFiles(plan.files, worktree);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...plan.env,
      NIGHTWATCH_SESSION_ID: id,
      NIGHTWATCH_DB: store.file,
      NIGHTWATCH_PROJECT_ROOT: o.projectRoot,
      NIGHTWATCH_WORKTREE: worktree,
      NIGHTWATCH_ADAPTER: plan.adapter,
      NIGHTWATCH_HOOK_NODE: o.hook.node,
      NIGHTWATCH_HOOK_SCRIPT: o.hook.script,
    };
    if (plan.shims) {
      const shims = createShims(rp.base, o.config.shim_commands, o.hook);
      Object.assign(env, shimEnv(shims.dir, env));
      runLog(`PATH shim guard active for ${shims.count} commands`);
    }
    runLog(`Guarded surfaces (${plan.displayName}): ${plan.coverage.covered.join(', ')}`);
    runLog(`Not covered: ${plan.coverage.uncovered.join('; ')}`);
    for (const n of plan.notes) runLog(`Note: ${n}`);
    store.insertTranscript(id, 'runner', `agent=${plan.displayName} covered=${plan.coverage.covered.join('|')} uncovered=${plan.coverage.uncovered.join('|')}`);

    // 3. Dashboard
    if (wantDashboard && preflight.port) {
      try {
        server = await startServer({
          store,
          sessionId: id,
          port: preflight.port,
          tokenFile: rp.token,
          render: (sid, token) => o.render(store, sid, { token }),
          model: (sid) => o.reportModel(store, sid),
          policyContext,
          onStop: (reason) => void requestStop(reason),
        });
        runLog(`Session running. Local dashboard: ${server.url}`);
      } catch (err) {
        runLog(`Dashboard unavailable: ${(err as Error).message}`);
      }
    }

    // 4. Spawn the agent
    store.setStatus(id, 'running');
    runLog(`Launching ${plan.displayName}: ${plan.command} ${plan.args.map((a) => (a.length > 60 ? `${a.slice(0, 57)}…` : a)).join(' ')}`);
    const streamOut = fs.openSync(rp.stream, 'a');
    child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env,
      stdio: [plan.promptViaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(plan.command),
    });
    o.onStarted?.({ sessionId: id, dashboardUrl: server?.url ?? null, worktree, plan });
    const childExit = new Promise<number | null>((resolve) => {
      child!.once('exit', (code) => resolve(code));
      child!.once('error', (err) => {
        runLog(`Agent failed to start: ${err.message}`);
        resolve(-1);
      });
    });

    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let model: string | null = o.model ?? null;
    let textLines = 0;
    const onLine = (line: string) => {
      try {
        fs.writeSync(streamOut, `${redactText(line)}\n`);
      } catch {
        /* ignore */
      }
      for (const ev of parseStreamLine(plan.stream, line)) {
        switch (ev.kind) {
          case 'init':
            if (ev.model) model = ev.model;
            store.updateSession(id, { claude_session_id: ev.sessionId ?? null, model });
            break;
          case 'text':
            if (textLines++ < 5000) store.insertTranscript(id, 'assistant', redactText(ev.text).slice(0, 20_000));
            break;
          case 'usage': {
            tokens.input += ev.input;
            tokens.output += ev.output;
            tokens.cacheRead += ev.cacheRead;
            tokens.cacheWrite += ev.cacheWrite;
            if (ev.model) model = ev.model;
            const cost = ev.costUsd ?? estimateCostUsd(o.config.pricing, model, tokens);
            store.addUsage(id, { input: ev.input, output: ev.output, cacheRead: ev.cacheRead, cacheWrite: ev.cacheWrite, costUsd: cost ?? undefined, model: model ?? undefined });
            break;
          }
          case 'result':
            store.addUsage(id, { costUsd: ev.costUsd, turns: ev.turns });
            store.insertTranscript(id, 'result', redactText(ev.text ?? '').slice(0, 20_000) || (ev.isError ? 'agent reported an error' : 'agent finished'));
            if (ev.isError) store.insertTranscript(id, 'error', 'agent reported is_error');
            break;
          case 'error':
            store.insertTranscript(id, 'error', redactText(ev.message).slice(0, 4000));
            break;
          default:
            break;
        }
      }
    };
    const rlOut = readline.createInterface({ input: child.stdout! });
    rlOut.on('line', onLine);
    const rlErr = readline.createInterface({ input: child.stderr! });
    rlErr.on('line', (line) => {
      try {
        fs.writeSync(streamOut, `[stderr] ${redactText(line)}\n`);
      } catch {
        /* ignore */
      }
    });
    if (plan.promptViaStdin && child.stdin) {
      child.stdin.end(o.task);
    }

    // 5. Watchdog
    const requestStop = async (reason: string) => {
      if (stopping) return;
      stopping = true;
      finalStop = reason;
      runLog(`Stopping: ${reason}`);
      store.updateSession(id, { status: 'stopping', stop_reason: reason });
      if (child) await killTree(child);
    };
    const onSignal = () => void requestStop('interrupted by signal');
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const watchdog = setInterval(() => {
      try {
        const s = store.getSession(id);
        if (!s) return;
        const reason = stopReason(store, s, policy);
        if (reason && !stopping) void requestStop(reason);
      } catch (err) {
        runLog(`watchdog error: ${(err as Error).message}`);
      }
    }, 3000);

    exitCode = await childExit;
    clearInterval(watchdog);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    fs.closeSync(streamOut);
    runLog(`Agent exited with code ${exitCode}`);
  } catch (err) {
    finalStop = finalStop ?? `run failed: ${(err as Error).message}`;
    runLog(finalStop);
    store.insertTranscript(id, 'error', finalStop);
    exitCode = exitCode ?? -1;
  }

  // 6. Finalise
  const ephemeral = [...written.map((w) => w.relative), FINDINGS_FILE];
  restoreEphemeralFiles(written);
  let patchFile = rp.patch;
  if (quarantine && fs.existsSync(worktree)) {
    try {
      const patch = exportPatch(worktree, baseRef, ephemeral);
      fs.writeFileSync(patchFile, patch);
      const files = changedFiles(worktree, baseRef, ephemeral);
      const commits = commitLog(worktree, baseRef);
      store.insertTranscript(id, 'runner', `changed_files=${files.length} commits=${commits.length} patch_bytes=${patch.length}`);
    } catch (err) {
      runLog(`could not export patch: ${(err as Error).message}`);
    }
  }
  const unchanged = fingerprintTree(o.projectRoot) === mainFingerprint;
  store.updateSession(id, { main_tree_unchanged: unchanged ? 1 : 0, pid: null });
  if (!unchanged) runLog('WARNING: the main working tree changed during the run. Review `git status` before trusting the report.');
  const status: SessionRecord['status'] = finalStop ? (finalStop.startsWith('run failed') ? 'failed' : 'stopped') : exitCode === 0 ? 'completed' : 'failed';
  store.setStatus(id, status, finalStop ?? (exitCode === 0 ? 'agent finished' : `agent exited with code ${exitCode}`));
  if (server) await server.close();

  let reportFile = rp.report;
  try {
    fs.writeFileSync(reportFile, o.render(store, id));
    fs.writeFileSync(rp.reportJson, JSON.stringify(o.reportModel(store, id), null, 2));
  } catch (err) {
    runLog(`report rendering failed: ${(err as Error).message}`);
    reportFile = '';
  }
  const result: RunResult = { sessionId: id, status, stopReason: store.getSession(id)?.stop_reason ?? null, worktree, branch, reportFile, patchFile, preflight, exitCode };
  store.close();
  return result;
}

function linkDependencies(projectRoot: string, worktree: string, dirs: string[], log: (s: string) => void): void {
  for (const d of dirs) {
    const src = path.join(projectRoot, d);
    const dst = path.join(worktree, d);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
      log(`Linked ${d} from the main tree (read-only by policy: writes resolve outside the worktree)`);
    } catch (err) {
      log(`Could not link ${d}: ${(err as Error).message}`);
    }
  }
}

/** Locate an agent binary for doctor/preflight without a full run. */
export function locateAgent(agentId: string, config: NightwatchConfig): string | null {
  const p = resolveProfile(agentId, config);
  if (!p) return null;
  const override = config.agents[agentId]?.command;
  for (const c of override ? [override] : p.binaries) {
    const f = findExecutable(c);
    if (f) return f;
  }
  return null;
}
