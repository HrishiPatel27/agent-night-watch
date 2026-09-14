import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { NightwatchStore } from '@nightwatch-agent/daemon';
import { policyToYaml, safeOvernightPreset } from '@nightwatch-agent/policy';
import { handleHook } from './run.js';
import { canonicalTool } from './tool-map.js';
import { selectAdapter } from './adapters/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '..', '..', '..', 'fixtures', 'hooks');

interface Env {
  env: NodeJS.ProcessEnv;
  worktree: string;
  projectRoot: string;
  db: string;
  cleanup: () => void;
}

function setup(): Env {
  const tmpRoot = path.resolve(here, '..', '.tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const base = fs.mkdtempSync(path.join(tmpRoot, 'hook-'));
  const projectRoot = path.join(base, 'project');
  const worktree = path.join(projectRoot, '.nightwatch', 'runs', 's1', 'worktree');
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'a.ts'), '');
  const db = path.join(projectRoot, '.nightwatch', 'nightwatch.db');
  const store = new NightwatchStore(db);
  const policy = safeOvernightPreset(['npm test']);
  store.createSession({
    id: 's1',
    project_root: projectRoot,
    worktree,
    branch: 'nightwatch/s1',
    base_ref: 'x',
    mode: 'quarantine',
    agent: 'claude-code',
    task: 't',
    policy_name: policy.name,
    policy_version: '1',
    policy_yaml: policyToYaml(policy, false),
    unattended: true,
    limits: { ...policy.limits },
    status: 'running',
  });
  store.close();
  return {
    env: { ...process.env, NIGHTWATCH_SESSION_ID: 's1', NIGHTWATCH_DB: db },
    worktree,
    projectRoot,
    db,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test('claude-code: denies dangerous commands with hookSpecificOutput and records events', () => {
  const e = setup();
  try {
    const pre = { session_id: 'abc', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' }, tool_use_id: 'tu1', cwd: e.worktree };
    const r = handleHook('claude-code', JSON.stringify(pre), e.env);
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /PROD_RISK/);
    const ok = handleHook('claude-code', JSON.stringify({ ...pre, tool_input: { command: 'git status' }, tool_use_id: 'tu2' }), e.env);
    assert.equal(ok.stdout, '');
    assert.equal(ok.exitCode, 0);
    const post = handleHook('claude-code', JSON.stringify({ ...pre, hook_event_name: 'PostToolUse', tool_input: { command: 'git status' }, tool_use_id: 'tu2', tool_response: { stdout: 'clean', stderr: '', exit_code: 0 } }), e.env);
    assert.equal(post.exitCode, 0);
    const store = new NightwatchStore(e.db);
    const events = store.listEvents('s1');
    assert.equal(events.length, 2);
    assert.equal(events[0].decision, 'deny');
    assert.equal(events[1].result_summary?.startsWith('exit 0; clean'), true);
    store.close();
  } finally {
    e.cleanup();
  }
});

test('test runs are parsed from PostToolUse output', () => {
  const e = setup();
  try {
    const base = { session_id: 'abc', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1', cwd: e.worktree };
    handleHook('claude-code', JSON.stringify({ ...base, hook_event_name: 'PreToolUse' }), e.env);
    handleHook('claude-code', JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_response: { stdout: 'Tests: 1 failed, 4 passed, 5 total', exit_code: 1 } }), e.env);
    const store = new NightwatchStore(e.db);
    const runs = store.listTestRuns('s1');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].failed, 1);
    assert.equal(runs[0].ok, 0);
    store.close();
  } finally {
    e.cleanup();
  }
});

test('fails closed on malformed input and inactive sessions', () => {
  const e = setup();
  try {
    const bad = handleHook('claude-code', '{not json', e.env);
    assert.equal(bad.exitCode, 2);
    assert.match(bad.stdout, /"permissionDecision":"deny"/);
    const gone = handleHook('claude-code', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' } }), { ...e.env, NIGHTWATCH_SESSION_ID: 'nope' });
    assert.match(gone.stdout, /SESSION_INACTIVE/);
  } finally {
    e.cleanup();
  }
});

test('unsupervised invocations pass through silently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-nosess-'));
  try {
    const r = handleHook('claude-code', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, cwd: dir }), { PATH: process.env.PATH });
    assert.equal(r.supervised, false);
    assert.equal(r.stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('budget: consecutive denials trigger BUDGET_EXCEEDED', () => {
  const e = setup();
  try {
    for (let i = 0; i < 5; i++) handleHook('claude-code', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sudo ls' }, tool_use_id: `d${i}`, cwd: e.worktree }), e.env);
    const r = handleHook('claude-code', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, tool_use_id: 'ok', cwd: e.worktree }), e.env);
    assert.match(r.stdout, /BUDGET_EXCEEDED/);
  } finally {
    e.cleanup();
  }
});

test('each adapter produces its native response format', () => {
  const e = setup();
  try {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['cursor', { conversation_id: 'c', hook_event_name: 'beforeShellExecution', command: 'git push', cwd: e.worktree, workspace_roots: [e.worktree] }, /"permission":"deny"/],
      ['gemini-cli', { session_id: 's', hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'git push' }, cwd: e.worktree }, /"decision":"deny"/],
      ['copilot-cli', { sessionId: 's', toolName: 'bash', toolArgs: { command: 'git push' }, cwd: e.worktree }, /"permissionDecision":"deny"/],
      ['codex', { session_id: 's', turn_id: 't', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'x', cwd: e.worktree }, /"permissionDecision":"deny"/],
      ['opencode', { hook_event_name: 'tool.execute.before', tool: 'bash', args: { command: 'git push' }, sessionID: 's', callID: 'c', cwd: e.worktree }, /"decision":"deny"/],
      ['generic', { tool: 'Bash', input: { command: 'git push' }, cwd: e.worktree }, /"decision":"deny"/],
      ['grok', { hookEventName: 'PreToolUse', toolName: 'run_terminal_command', toolInput: { command: 'git push' }, sessionId: 's', cwd: e.worktree }, /"permissionDecision":"deny"/],
    ];
    const allowCursor = handleHook('cursor', JSON.stringify({ conversation_id: 'c', hook_event_name: 'beforeReadFile', file_path: path.join(e.worktree, 'src', 'a.ts'), workspace_roots: [e.worktree] }), e.env);
    assert.equal(JSON.parse(allowCursor.stdout).permission, 'allow');
    for (const [adapter, payload, re] of cases) {
      // Interleave an allowed call so the consecutive-denial budget does not trip.
      handleHook('generic', JSON.stringify({ tool: 'Read', input: { file_path: path.join(e.worktree, 'src', 'a.ts') }, cwd: e.worktree }), e.env);
      const r = handleHook(adapter, JSON.stringify(payload), e.env);
      assert.match(r.stdout, re, `${adapter}: ${r.stdout}`);
    }
    const auto = handleHook('auto', JSON.stringify(cases[0][1]), e.env);
    assert.equal(auto.adapter, 'cursor');
    handleHook('generic', JSON.stringify({ tool: 'Read', input: { file_path: path.join(e.worktree, 'src', 'a.ts') }, cwd: e.worktree }), e.env);
    const amp = handleHook('amp', JSON.stringify({ tool: 'Bash', input: { command: 'git push' }, cwd: e.worktree }), e.env);
    assert.equal(amp.exitCode, 2);
  } finally {
    e.cleanup();
  }
});

test('hook payload fixtures normalise to canonical tools', () => {
  for (const name of fs.readdirSync(fixtures)) {
    const raw = JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8')) as { adapter?: string; payload: Record<string, unknown>; expect: { tool?: string; phase: string; command?: string; file_path?: string } };
    const adapter = selectAdapter(raw.adapter ?? 'auto', raw.payload);
    const n = adapter.normalize(raw.payload);
    assert.equal(n.phase, raw.expect.phase, name);
    if (raw.expect.tool) assert.equal(n.tool, raw.expect.tool, name);
    if (raw.expect.command) assert.equal(n.input?.command, raw.expect.command, name);
    if (raw.expect.file_path) assert.equal(n.input?.file_path, raw.expect.file_path, name);
  }
});

test('tool-map handles agent-specific names', () => {
  assert.equal(canonicalTool('run_shell_command', { command: 'ls' }).tool, 'Bash');
  assert.equal(canonicalTool('mcp_github_create_issue', {}).tool, 'mcp__github__create_issue');
  assert.equal(canonicalTool('MCP:search', {}).tool, 'mcp__cursor__search');
  assert.equal(canonicalTool('apply_patch', { patch: '*** Begin Patch\n*** Update File: src/x.ts\n' }).input.file_path, 'src/x.ts');
  assert.equal(canonicalTool('view', { path: 'a.txt' }).input.file_path, 'a.txt');
});

test('bin: end-to-end via stdin', () => {
  const e = setup();
  try {
    const bin = path.resolve(here, 'bin.js');
    const out = execFileSync(process.execPath, [bin, 'claude-code'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat ~/.ssh/id_rsa' }, cwd: e.worktree }), env: e.env, encoding: 'utf8' });
    assert.match(out, /SECRET_PATH/);
    const self = execFileSync(process.execPath, [bin, '--selftest'], { encoding: 'utf8' });
    assert.match(self, /ok/);
  } finally {
    e.cleanup();
  }
});
