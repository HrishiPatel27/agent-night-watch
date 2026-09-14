import fs from 'node:fs';
import path from 'node:path';
import { hookCommandString, writeHookWrappers, type HookCommand } from '@nightwatch-agent/daemon';

export interface InstallResult {
  file: string;
  action: 'created' | 'merged' | 'unchanged' | 'removed';
  note?: string;
}

const MARK = 'nightwatch';

/**
 * Project-local hook installation for interactive (guard mode) use. Each agent
 * reads hooks from a different file; we merge into existing JSON and never
 * remove other people's hooks.
 */
export function installProjectHooks(agent: string, projectRoot: string, hc: HookCommand): InstallResult {
  switch (agent) {
    case 'claude-code': {
      const file = path.join(projectRoot, '.claude', 'settings.local.json');
      const cmd = hookCommandString(hc, 'claude-code');
      const entry = { type: 'command', command: cmd, timeout: 60, ...(process.platform === 'win32' ? { shell: 'bash' } : {}) };
      return mergeHooksFile(file, ['PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'], () => ({ matcher: '', hooks: [entry] }), 'settings.local.json is ignored by git by default');
    }
    case 'codex': {
      const file = path.join(projectRoot, '.codex', 'hooks.json');
      const entry = { type: 'command', command: hookCommandString(hc, 'codex'), timeout: 60 };
      return mergeHooksFile(file, ['PreToolUse', 'PostToolUse', 'Stop'], () => ({ matcher: '', hooks: [entry] }), 'Codex must trust the project (or run with --dangerously-bypass-hook-trust)');
    }
    case 'grok': {
      const file = path.join(projectRoot, '.grok', 'hooks', 'nightwatch.json');
      const entry = { type: 'command', command: hookCommandString(hc, 'grok'), timeout: 60 };
      return mergeHooksFile(file, ['PreToolUse', 'PostToolUse', 'Stop'], () => ({ matcher: '', hooks: [entry] }), 'trust the project hooks with /hooks-trust in Grok');
    }
    case 'gemini-cli': {
      const file = path.join(projectRoot, '.gemini', 'settings.json');
      const cmd = hookCommandString(hc, 'gemini-cli');
      return mergeHooksFile(file, ['BeforeTool', 'AfterTool'], (ev) => ({ matcher: '', hooks: [{ name: ev === 'BeforeTool' ? 'nightwatch' : 'nightwatch-post', type: 'command', command: cmd, timeout: 60000 }] }));
    }
    case 'cursor': {
      const file = path.join(projectRoot, '.cursor', 'hooks.json');
      const wrappers = writeHookWrappers(path.join(projectRoot, '.nightwatch'), hc, 'cursor');
      const entry = { command: wrappers.native, timeout: 60, failClosed: true };
      const r = mergeFlatHooksFile(file, ['beforeShellExecution', 'afterShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'afterFileEdit', 'preToolUse', 'postToolUse'], entry);
      r.note = '.cursor/hooks.json may be committed; the wrapper path is machine-specific';
      return r;
    }
    case 'copilot-cli': {
      const file = path.join(projectRoot, '.github', 'hooks', 'nightwatch.json');
      const bash = hookCommandString(hc, 'copilot-cli');
      const powershell = `& "${hc.node}" "${hc.script}" copilot-cli`;
      const body = { version: 1, hooks: { preToolUse: [{ type: 'command', bash, powershell, timeoutSec: 60 }], postToolUse: [{ type: 'command', bash, powershell, timeoutSec: 60 }] } };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const existed = fs.existsSync(file);
      fs.writeFileSync(file, JSON.stringify(body, null, 2));
      return { file, action: existed ? 'merged' : 'created' };
    }
    default:
      throw new Error(`no project hook installer for agent "${agent}" (supported: claude-code, codex, grok, gemini-cli, cursor, copilot-cli)`);
  }
}

export function uninstallProjectHooks(agent: string, projectRoot: string): InstallResult {
  const files: Record<string, string> = {
    'claude-code': path.join(projectRoot, '.claude', 'settings.local.json'),
    codex: path.join(projectRoot, '.codex', 'hooks.json'),
    grok: path.join(projectRoot, '.grok', 'hooks', 'nightwatch.json'),
    'gemini-cli': path.join(projectRoot, '.gemini', 'settings.json'),
    cursor: path.join(projectRoot, '.cursor', 'hooks.json'),
    'copilot-cli': path.join(projectRoot, '.github', 'hooks', 'nightwatch.json'),
  };
  const file = files[agent];
  if (!file) throw new Error(`unknown agent "${agent}"`);
  if (!fs.existsSync(file)) return { file, action: 'unchanged' };
  if (agent === 'copilot-cli' || agent === 'grok') {
    fs.rmSync(file);
    return { file, action: 'removed' };
  }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks?: Record<string, unknown[]> };
  if (!doc.hooks) return { file, action: 'unchanged' };
  let changed = false;
  for (const [ev, entries] of Object.entries(doc.hooks)) {
    const kept = entries.filter((e) => !JSON.stringify(e).includes(MARK));
    if (kept.length !== entries.length) changed = true;
    if (kept.length) doc.hooks[ev] = kept;
    else delete doc.hooks[ev];
  }
  if (!changed) return { file, action: 'unchanged' };
  if (!Object.keys(doc.hooks).length) delete doc.hooks;
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return { file, action: 'removed' };
}

function mergeHooksFile(file: string, events: string[], make: (ev: string) => unknown, note?: string): InstallResult {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let doc: { hooks?: Record<string, unknown[]>; [k: string]: unknown } = {};
  const existed = fs.existsSync(file);
  if (existed) {
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof doc;
    } catch {
      throw new Error(`${file} is not valid JSON; fix or remove it first`);
    }
  }
  doc.hooks ??= {};
  let changed = false;
  for (const ev of events) {
    const list = Array.isArray(doc.hooks[ev]) ? doc.hooks[ev] : [];
    if (list.some((e) => JSON.stringify(e).includes(MARK))) continue;
    doc.hooks[ev] = [make(ev), ...list];
    changed = true;
  }
  if (!changed) return { file, action: 'unchanged', note };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return { file, action: existed ? 'merged' : 'created', note };
}

function mergeFlatHooksFile(file: string, events: string[], entry: unknown): InstallResult {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let doc: { version?: number; hooks?: Record<string, unknown[]> } = { version: 1 };
  const existed = fs.existsSync(file);
  if (existed) doc = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof doc;
  doc.version ??= 1;
  doc.hooks ??= {};
  let changed = false;
  for (const ev of events) {
    const list = Array.isArray(doc.hooks[ev]) ? doc.hooks[ev] : [];
    if (list.some((e) => JSON.stringify(e).includes(MARK))) continue;
    doc.hooks[ev] = [entry, ...list];
    changed = true;
  }
  if (!changed) return { file, action: 'unchanged' };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return { file, action: existed ? 'merged' : 'created' };
}
