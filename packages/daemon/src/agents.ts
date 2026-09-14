import fs from 'node:fs';
import path from 'node:path';
import { FINDINGS_FILE, toPosix, type Policy } from '@nightwatch-agent/shared';
import type { NightwatchConfig, AgentOverride } from './config.js';
import { FINDINGS_INSTRUCTIONS } from './findings.js';

/** Absolute paths of the Node binary and the Nightwatch hook entry script. */
export interface HookCommand {
  node: string;
  script: string;
}

export type StreamFormat = 'claude-stream-json' | 'codex-jsonl' | 'cursor-stream-json' | 'gemini-stream-json' | 'opencode-json' | 'generic-jsonl' | 'text';

export interface EphemeralFile {
  path: string;
  content: string;
  /** How to combine with an existing file at that path. */
  merge?: 'claude-hooks' | 'cursor-hooks' | 'gemini-hooks' | 'copilot-hooks' | 'replace';
}

export interface LaunchPlan {
  agentId: string;
  displayName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  files: EphemeralFile[];
  stream: StreamFormat;
  adapter: string;
  shims: boolean;
  coverage: { covered: string[]; uncovered: string[] };
  notes: string[];
  experimental: boolean;
  promptViaStdin?: boolean;
}

export interface LaunchOptions {
  agentId: string;
  task: string;
  instructions: string;
  worktree: string;
  runDir: string;
  projectRoot: string;
  hook: HookCommand;
  config: NightwatchConfig;
  policy: Policy;
  budgetUsd?: number;
  maxTurns?: number;
  model?: string;
}

export interface AgentProfile {
  id: string;
  displayName: string;
  binaries: string[];
  experimental: boolean;
  plan(o: LaunchOptions, binary: string, override: AgentOverride): LaunchPlan;
}

/** Shell-form hook command: quoted node + script + adapter, forward slashes so Git Bash on Windows is happy. */
export function hookCommandString(hc: HookCommand, adapter: string): string {
  return `"${toPosix(hc.node)}" "${toPosix(hc.script)}" ${adapter}`;
}

/** Wrapper scripts for agents that take a bare command path (Cursor, Amp). */
export function writeHookWrappers(runDir: string, hc: HookCommand, adapter: string): { sh: string; cmd: string; native: string } {
  const dir = path.join(runDir, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const sh = path.join(dir, `nightwatch-${adapter}.sh`);
  const cmd = path.join(dir, `nightwatch-${adapter}.cmd`);
  fs.writeFileSync(sh, `#!/bin/sh\n# Nightwatch hook wrapper (${adapter})\nexec "${toPosix(hc.node)}" "${toPosix(hc.script)}" ${adapter} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(cmd, `@echo off\r\n"${hc.node}" "${hc.script}" ${adapter} %*\r\nexit /b %ERRORLEVEL%\r\n`);
  return { sh, cmd, native: process.platform === 'win32' ? cmd : sh };
}

function claudeStyleHooks(command: string, events: string[], timeoutSec: number, execForm: boolean, hc: HookCommand, adapter: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const hook = execForm
    ? { type: 'command', command: hc.node, args: [hc.script, adapter], timeout: timeoutSec, ...extra }
    : { type: 'command', command, timeout: timeoutSec, ...(process.platform === 'win32' ? { shell: 'bash' } : {}), ...extra };
  const hooks: Record<string, unknown> = {};
  for (const ev of events) hooks[ev] = [{ matcher: '', hooks: [hook] }];
  return { hooks };
}

const COMMON_UNCOVERED = ['processes already running before the run', 'network traffic from allowed commands', 'OS-level isolation (no sandbox/container)', 'secrets embedded in ordinary files'];

export function buildInstructions(o: { worktree: string; branch: string | null; hours: number; budgetUsd?: number; policyName: string; agentName: string; unknownCommands: string }): string {
  return [
    `You are running unattended overnight under Nightwatch, a deterministic supervisor. Nobody will answer questions until morning, so never wait for confirmation; make the safest reasonable choice and continue.`,
    `Working directory: ${o.worktree} — a disposable git worktree${o.branch ? ` on branch ${o.branch}` : ''}. Commit your work on this branch with clear messages. Do not switch branches, push, publish, deploy, or touch files outside this directory.`,
    `Every tool call is checked by a policy ("${o.policyName}"). A blocked call returns a reason code. Do not retry the same blocked action more than once; note it and move on. Repeated denials stop the run.${o.unknownCommands === 'defer' ? ' Commands that are not on the allow list are blocked; prefer the project\'s own test/lint/build commands and the built-in read-only tools.' : ''}`,
    `Limits: about ${o.hours} hour(s) of wall time${o.budgetUsd ? `, an estimated spend ceiling of $${o.budgetUsd.toFixed(2)}` : ''}. Leave the tree in a coherent, committed state well before the limit.`,
    FINDINGS_INSTRUCTIONS,
    `Finish by writing a short summary of what you did, what you found, and what a human should look at first.`,
  ].join('\n\n');
}

const claudeCode: AgentProfile = {
  id: 'claude-code',
  displayName: 'Claude Code',
  binaries: ['claude'],
  experimental: false,
  plan(o, binary, ov) {
    const settingsFile = path.join(o.runDir, 'claude-settings.json');
    const instructionsFile = path.join(o.runDir, 'instructions.md');
    fs.writeFileSync(instructionsFile, o.instructions);
    const settings = claudeStyleHooks(hookCommandString(o.hook, 'claude-code'), ['PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'], 60, o.config.hooks_exec_form, o.hook, 'claude-code');
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    const args = ['-p', o.task, '--output-format', 'stream-json', '--verbose', '--settings', settingsFile, '--append-system-prompt-file', instructionsFile, '--dangerously-skip-permissions', '--no-session-persistence'];
    if (o.budgetUsd) args.push('--max-budget-usd', String(o.budgetUsd));
    if (o.maxTurns) args.push('--max-turns', String(o.maxTurns));
    const model = o.model ?? ov.model;
    if (model) args.push('--model', model);
    args.push(...(ov.extra_args ?? []));
    return {
      agentId: 'claude-code',
      displayName: 'Claude Code',
      command: binary,
      args,
      env: {},
      cwd: o.worktree,
      files: [],
      stream: 'claude-stream-json',
      adapter: 'claude-code',
      shims: ov.shims ?? false,
      coverage: { covered: ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'MCP tools', 'subagent tool calls'], uncovered: COMMON_UNCOVERED },
      notes: ['Hooks are passed with --settings, so nothing is written into the repository.'],
      experimental: false,
    };
  },
};

const codex: AgentProfile = {
  id: 'codex',
  displayName: 'OpenAI Codex CLI',
  binaries: ['codex'],
  experimental: true,
  plan(o, binary, ov) {
    const hooks = claudeStyleHooks(hookCommandString(o.hook, 'codex'), ['PreToolUse', 'PostToolUse', 'Stop'], 60, false, o.hook, 'codex');
    const args = ['exec', '-C', o.worktree, '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-c', `projects.${JSON.stringify(o.worktree)}.trust_level="trusted"`];
    const model = o.model ?? ov.model;
    if (model) args.push('-m', model);
    args.push(...(ov.extra_args ?? []));
    args.push(`${o.task}\n\n${o.instructions}`);
    return {
      agentId: 'codex',
      displayName: 'OpenAI Codex CLI',
      command: binary,
      args,
      env: {},
      cwd: o.worktree,
      files: [{ path: path.join(o.worktree, '.codex', 'hooks.json'), content: JSON.stringify(hooks, null, 2), merge: 'claude-hooks' }],
      stream: 'codex-jsonl',
      adapter: 'codex',
      shims: ov.shims ?? true,
      coverage: { covered: ['shell commands (Bash)', 'apply_patch edits (Edit/Write)', 'MCP tools', "Codex's own workspace-write sandbox"], uncovered: ['"ask" decisions (Codex fails open on ask, so Nightwatch denies instead)', ...COMMON_UNCOVERED] },
      notes: ['Hooks are written to .codex/hooks.json inside the worktree for this run only.', 'Codex hook support is recent; run `nightwatch doctor --agent codex` to verify your version fires PreToolUse.'],
      experimental: true,
    };
  },
};

const geminiCli: AgentProfile = {
  id: 'gemini-cli',
  displayName: 'Google Gemini CLI',
  binaries: ['gemini'],
  experimental: true,
  plan(o, binary, ov) {
    const cmd = hookCommandString(o.hook, 'gemini-cli');
    const settings = {
      hooks: {
        BeforeTool: [{ matcher: '', hooks: [{ name: 'nightwatch', type: 'command', command: cmd, timeout: 60000, description: 'Nightwatch policy check' }] }],
        AfterTool: [{ matcher: '', hooks: [{ name: 'nightwatch-post', type: 'command', command: cmd, timeout: 60000 }] }],
        SessionEnd: [{ hooks: [{ name: 'nightwatch-end', type: 'command', command: cmd, timeout: 60000 }] }],
      },
    };
    const args = ['-p', `${o.task}\n\n${o.instructions}`, '--approval-mode', 'yolo', '--output-format', 'stream-json'];
    const model = o.model ?? ov.model;
    if (model) args.push('-m', model);
    args.push(...(ov.extra_args ?? []));
    return {
      agentId: 'gemini-cli',
      displayName: 'Google Gemini CLI',
      command: binary,
      args,
      env: {},
      cwd: o.worktree,
      files: [{ path: path.join(o.worktree, '.gemini', 'settings.json'), content: JSON.stringify(settings, null, 2), merge: 'gemini-hooks' }],
      stream: 'gemini-stream-json',
      adapter: 'gemini-cli',
      shims: ov.shims ?? true,
      coverage: { covered: ['run_shell_command', 'read_file / read_many_files', 'write_file / replace', 'glob / grep', 'web_fetch / google_web_search', 'MCP tools'], uncovered: ['"ask" decisions (Gemini hooks only allow/deny)', ...COMMON_UNCOVERED] },
      notes: ['Hooks are written to .gemini/settings.json inside the worktree; Gemini requires the folder to be trusted.'],
      experimental: true,
    };
  },
};

const copilotCli: AgentProfile = {
  id: 'copilot-cli',
  displayName: 'GitHub Copilot CLI',
  binaries: ['copilot'],
  experimental: true,
  plan(o, binary, ov) {
    const bash = hookCommandString(o.hook, 'copilot-cli');
    const ps = `& "${o.hook.node}" "${o.hook.script}" copilot-cli`;
    const hooks = {
      version: 1,
      hooks: {
        preToolUse: [{ type: 'command', bash, powershell: ps, timeoutSec: 60 }],
        postToolUse: [{ type: 'command', bash, powershell: ps, timeoutSec: 60 }],
        sessionEnd: [{ type: 'command', bash, powershell: ps, timeoutSec: 60 }],
      },
    };
    const args = ['-p', `${o.task}\n\n${o.instructions}`, '--allow-all-tools', '--output-format', 'json', '--no-ask-user'];
    const model = o.model ?? ov.model;
    if (model) args.push('--model', model);
    args.push(...(ov.extra_args ?? []));
    return {
      agentId: 'copilot-cli',
      displayName: 'GitHub Copilot CLI',
      command: binary,
      args,
      env: { GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS: '1' },
      cwd: o.worktree,
      files: [{ path: path.join(o.worktree, '.github', 'hooks', 'nightwatch.json'), content: JSON.stringify(hooks, null, 2), merge: 'replace' }],
      stream: 'generic-jsonl',
      adapter: 'copilot-cli',
      shims: ov.shims ?? true,
      coverage: { covered: ['bash', 'edit / create / view', 'grep / glob', 'web_fetch / web_search', 'MCP tools'], uncovered: ['hook timeouts fail open in Copilot; Nightwatch keeps its hook fast', ...COMMON_UNCOVERED] },
      notes: ['Hooks are written to .github/hooks/nightwatch.json inside the worktree; Copilot loads repo hooks in -p mode when the folder is trusted.'],
      experimental: true,
    };
  },
};

const cursor: AgentProfile = {
  id: 'cursor',
  displayName: 'Cursor CLI',
  binaries: ['agent', 'cursor-agent'],
  experimental: true,
  plan(o, binary, ov) {
    const wrappers = writeHookWrappers(o.runDir, o.hook, 'cursor');
    const entry = { command: wrappers.native, timeout: 60, failClosed: true };
    const hooks = {
      version: 1,
      hooks: {
        beforeShellExecution: [entry],
        afterShellExecution: [entry],
        beforeMCPExecution: [entry],
        beforeReadFile: [entry],
        afterFileEdit: [entry],
        preToolUse: [entry],
        postToolUse: [entry],
        stop: [entry],
      },
    };
    const args = ['-p', `${o.task}\n\n${o.instructions}`, '--force', '--output-format', 'stream-json', '--workspace', o.worktree];
    const model = o.model ?? ov.model;
    if (model) args.push('--model', model);
    args.push(...(ov.extra_args ?? []));
    return {
      agentId: 'cursor',
      displayName: 'Cursor CLI',
      command: binary,
      args,
      env: {},
      cwd: o.worktree,
      files: [{ path: path.join(o.worktree, '.cursor', 'hooks.json'), content: JSON.stringify(hooks, null, 2), merge: 'cursor-hooks' }],
      stream: 'cursor-stream-json',
      adapter: 'cursor',
      shims: ov.shims ?? true,
      coverage: { covered: ['shell commands (beforeShellExecution)', 'MCP tools (beforeMCPExecution)', 'file reads (beforeReadFile, IDE)', 'preToolUse where the CLI emits it'], uncovered: ['file writes in the CLI (the CLI may only fire shell/MCP hooks) — worktree isolation and PATH shims still apply', ...COMMON_UNCOVERED] },
      notes: ['Hooks are written to .cursor/hooks.json inside the worktree; Cursor has no flag for an alternate hooks file.'],
      experimental: true,
    };
  },
};

const grok: AgentProfile = {
  id: 'grok',
  displayName: 'xAI Grok Build',
  binaries: ['grok'],
  experimental: true,
  plan(o, binary, ov) {
    const hooks = claudeStyleHooks(hookCommandString(o.hook, 'grok'), ['PreToolUse', 'PostToolUse', 'Stop'], 60, false, o.hook, 'grok');
    const args = ['-p', `${o.task}\n\n${o.instructions}`, '--yolo', '--output-format', 'streaming-messages-json', '--cwd', o.worktree, '--trust'];
    if (o.maxTurns) args.push('--max-turns', String(o.maxTurns));
    const model = o.model ?? ov.model;
    if (model) args.push('-m', model);
    args.push(...(ov.extra_args ?? []));
    return {
      agentId: 'grok',
      displayName: 'xAI Grok Build',
      command: binary,
      args,
      env: {},
      cwd: o.worktree,
      files: [{ path: path.join(o.worktree, '.grok', 'hooks', 'nightwatch.json'), content: JSON.stringify(hooks, null, 2), merge: 'replace' }],
      stream: 'claude-stream-json',
      adapter: 'grok',
      shims: ov.shims ?? true,
      coverage: { covered: ['run_terminal_command (Bash)', 'file read/write/edit tools', 'search tools', 'web fetch/search', 'MCP tools'], uncovered: COMMON_UNCOVERED },
      notes: ['Hooks are written to .grok/hooks/nightwatch.json inside the worktree and trusted with --trust.'],
      experimental: true,
    };
  },
};

const opencode: AgentProfile = {
  id: 'opencode',
  displayName: 'OpenCode',
  binaries: ['opencode'],
  experimental: true,
  plan(o, binary, ov) {
    const plugin = `// Nightwatch plugin for OpenCode: forwards every tool call to the Nightwatch policy engine.
import { spawnSync } from "node:child_process";
const NODE = ${JSON.stringify(o.hook.node)};
const SCRIPT = ${JSON.stringify(o.hook.script)};
function check(payload) {
  const r = spawnSync(NODE, [SCRIPT, "opencode"], { input: JSON.stringify(payload), encoding: "utf8", timeout: 60000 });
  if (r.error) throw new Error("Nightwatch hook failed (fail closed): " + r.error.message);
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch { throw new Error("Nightwatch hook returned invalid JSON (fail closed)"); }
  if (out.decision && out.decision !== "allow") throw new Error("[Nightwatch " + (out.reasonCode || "DENY") + "] " + (out.reason || "blocked by policy"));
}
export const NightwatchPlugin = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => {
    check({ hook_event_name: "tool.execute.before", tool: input.tool, args: output.args, sessionID: input.sessionID, callID: input.callID, cwd: directory });
  },
  "tool.execute.after": async (input, output) => {
    try { check({ hook_event_name: "tool.execute.after", tool: input.tool, args: input.args, sessionID: input.sessionID, callID: input.callID, cwd: directory, output: String(output.output || "").slice(0, 20000) }); } catch {}
  },
});
`;
    const args = ['run', '--dir', o.worktree, '--format', 'json', '--auto'];
    const model = o.model ?? ov.model;
    if (model) args.push('-m', model);
    args.push(...(ov.extra_args ?? []));
    args.push(`${o.task}\n\n${o.instructions}`);
    return {
      agentId: 'opencode',
      displayName: 'OpenCode',
      command: binary,
      args,
      env: {},
      cwd: o.worktree,
      files: [{ path: path.join(o.worktree, '.opencode', 'plugins', 'nightwatch.mjs'), content: plugin, merge: 'replace' }],
      stream: 'opencode-json',
      adapter: 'opencode',
      shims: ov.shims ?? true,
      coverage: { covered: ['every tool call via the tool.execute.before plugin hook (bash, edit, write, read, glob, grep, webfetch, MCP)'], uncovered: COMMON_UNCOVERED },
      notes: ['A plugin is written to .opencode/plugins/nightwatch.mjs inside the worktree for this run only.'],
      experimental: true,
    };
  },
};

const amp: AgentProfile = {
  id: 'amp',
  displayName: 'Amp',
  binaries: ['amp'],
  experimental: true,
  plan(o, binary, ov) {
    const wrappers = writeHookWrappers(o.runDir, o.hook, 'amp');
    const settingsFile = path.join(o.runDir, 'amp-settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ 'amp.permissions': [{ tool: '*', action: 'delegate', to: wrappers.native }] }, null, 2));
    const args = ['-x', `${o.task}\n\n${o.instructions}`, '--dangerously-allow-all', '--stream-json', '--settings-file', settingsFile, ...(ov.extra_args ?? [])];
    return {
      agentId: 'amp',
      displayName: 'Amp',
      command: binary,
      args,
      env: {},
      cwd: o.worktree,
      files: [],
      stream: 'claude-stream-json',
      adapter: 'amp',
      shims: ov.shims ?? true,
      coverage: { covered: ['tool calls delegated through amp.permissions (exit 0 allow / 1 ask / 2 reject)'], uncovered: ['tools not routed through the delegate rule', ...COMMON_UNCOVERED] },
      notes: ['Permissions are passed with --settings-file; nothing is written into the repository.'],
      experimental: true,
    };
  },
};

const aider: AgentProfile = {
  id: 'aider',
  displayName: 'Aider',
  binaries: ['aider'],
  experimental: true,
  plan(o, binary, ov) {
    const args = ['--message', `${o.task}\n\n${o.instructions}`, '--yes-always', '--no-pretty', '--no-stream', ...(ov.extra_args ?? [])];
    const model = o.model ?? ov.model;
    if (model) args.push('--model', model);
    return {
      agentId: 'aider',
      displayName: 'Aider',
      command: binary,
      args,
      env: {},
      cwd: o.worktree,
      files: [],
      stream: 'text',
      adapter: 'shim',
      shims: true,
      coverage: { covered: ['commands run through the PATH shim guard (git, rm, curl, npm, python, …)', 'worktree isolation'], uncovered: ['Aider has no hook mechanism: file edits made by Aider itself are not intercepted (only contained by the worktree)', ...COMMON_UNCOVERED] },
      notes: ['Aider is guarded by PATH shims and the worktree only.'],
      experimental: true,
    };
  },
};

export const PROFILES: Record<string, AgentProfile> = Object.fromEntries([claudeCode, codex, geminiCli, copilotCli, cursor, grok, opencode, amp, aider].map((p) => [p.id, p]));

export function listAgentIds(config?: NightwatchConfig): string[] {
  return [...new Set([...Object.keys(PROFILES), ...Object.keys(config?.agents ?? {})])];
}

/** Custom agents defined in config.yaml with a command template. */
function customProfile(id: string, ov: AgentOverride): AgentProfile {
  return {
    id,
    displayName: id,
    binaries: [ov.command ?? (ov.template ? splitTemplate(ov.template)[0] : id)],
    experimental: true,
    plan(o, binary, override) {
      const template = override.template ?? `${binary} {prompt}`;
      const prompt = `${o.task}\n\n${o.instructions}`;
      const tokens = splitTemplate(template).map((t) => t.replace('{prompt}', prompt).replace('{worktree}', o.worktree).replace('{run_dir}', o.runDir).replace('{project_root}', o.projectRoot));
      const files: EphemeralFile[] = [];
      let notes = [`Custom agent "${id}" from config.yaml.`];
      if (override.hooks === 'claude-settings-file') {
        const hooks = claudeStyleHooks(hookCommandString(o.hook, 'claude-code'), ['PreToolUse', 'PostToolUse'], 60, false, o.hook, 'claude-code');
        const f = path.join(o.runDir, 'hooks-settings.json');
        fs.writeFileSync(f, JSON.stringify(hooks, null, 2));
        notes.push(`Claude-style hook settings written to ${f}; pass it to your agent via {run_dir}.`);
      } else notes.push('No hook integration configured; PATH shims and the worktree are the only guards.');
      return {
        agentId: id,
        displayName: id,
        command: tokens[0] ?? binary,
        args: [...tokens.slice(1), ...(override.extra_args ?? [])],
        env: {},
        cwd: o.worktree,
        files,
        stream: (override.stream as StreamFormat) ?? 'text',
        adapter: 'generic',
        shims: override.shims ?? true,
        coverage: { covered: ['commands run through the PATH shim guard', 'worktree isolation'], uncovered: ['tool calls made without spawning a shimmed command', ...COMMON_UNCOVERED] },
        notes,
        experimental: true,
      };
    },
  };
}

function splitTemplate(t: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of t.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function resolveProfile(id: string, config: NightwatchConfig): AgentProfile | null {
  if (PROFILES[id]) return PROFILES[id];
  const ov = config.agents[id];
  if (ov && (ov.template || ov.command)) return customProfile(id, ov);
  return null;
}

export function planLaunch(o: LaunchOptions, binary: string): LaunchPlan {
  const profile = resolveProfile(o.agentId, o.config);
  if (!profile) throw new Error(`unknown agent "${o.agentId}"; known: ${listAgentIds(o.config).join(', ')}`);
  const ov = o.config.agents[o.agentId] ?? {};
  return profile.plan(o, binary, ov);
}

// ---------------------------------------------------------------------------
// Ephemeral hook files: write (merging with anything the repo already has) and restore.
// ---------------------------------------------------------------------------

export interface WrittenFile {
  path: string;
  existed: boolean;
  original: string | null;
  /** Path relative to the worktree (for diff exclusion). */
  relative: string;
}

export function writeEphemeralFiles(files: EphemeralFile[], worktree: string): WrittenFile[] {
  const out: WrittenFile[] = [];
  for (const f of files) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    const existed = fs.existsSync(f.path);
    const original = existed ? fs.readFileSync(f.path, 'utf8') : null;
    let content = f.content;
    if (existed && original && f.merge && f.merge !== 'replace') {
      content = mergeJsonHooks(original, f.content, f.merge);
    }
    fs.writeFileSync(f.path, content);
    out.push({ path: f.path, existed, original, relative: toPosix(path.relative(worktree, f.path)) });
  }
  return out;
}

export function restoreEphemeralFiles(files: WrittenFile[]): void {
  for (const f of files) {
    try {
      if (f.existed && f.original != null) fs.writeFileSync(f.path, f.original);
      else fs.rmSync(f.path, { force: true });
    } catch {
      /* best effort */
    }
  }
}

function mergeJsonHooks(originalText: string, oursText: string, kind: NonNullable<EphemeralFile['merge']>): string {
  let orig: Record<string, unknown>;
  try {
    orig = JSON.parse(originalText) as Record<string, unknown>;
  } catch {
    return oursText; // unparsable original: ours wins for the run, original restored afterwards
  }
  const ours = JSON.parse(oursText) as Record<string, unknown>;
  const origHooks = (orig.hooks ?? {}) as Record<string, unknown[]>;
  const ourHooks = (ours.hooks ?? {}) as Record<string, unknown[]>;
  const merged: Record<string, unknown[]> = { ...origHooks };
  for (const [ev, entries] of Object.entries(ourHooks)) {
    // Ours run first so a deny is never pre-empted by a permissive repo hook.
    merged[ev] = [...entries, ...(Array.isArray(origHooks[ev]) ? origHooks[ev] : [])];
  }
  const out = { ...orig, ...ours, hooks: merged };
  if (kind === 'claude-hooks' && (orig as { disableAllHooks?: boolean }).disableAllHooks) (out as { disableAllHooks?: boolean }).disableAllHooks = false;
  return JSON.stringify(out, null, 2);
}

export { FINDINGS_FILE };
