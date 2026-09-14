import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface SessionRow {
  id: string;
  status: string;
  agent: string;
  port: number | null;
  task: string;
  started_at: string;
  actions: number;
  decisions: Record<string, number>;
  cost_usd: number | null;
}

let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let timer: NodeJS.Timeout | undefined;

function cfg<T>(key: string, dflt: T): T {
  return vscode.workspace.getConfiguration('nightwatch').get<T>(key, dflt);
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function cli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const bin = cfg('cliPath', 'nightwatch');
    execFile(bin, args, { cwd, shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: err ? ((err as { code?: number }).code ?? 1) : 0 });
    });
  });
}

async function sessions(cwd: string): Promise<SessionRow[]> {
  const r = await cli(['status', '--json'], cwd);
  if (r.code !== 0) return [];
  try {
    return JSON.parse(r.stdout) as SessionRow[];
  } catch {
    return [];
  }
}

async function refreshStatus(): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  if (!fs.existsSync(path.join(root, '.nightwatch', 'policy.yaml'))) {
    statusBar.text = '$(shield) Nightwatch: not initialised';
    statusBar.command = 'nightwatch.init';
    statusBar.show();
    return;
  }
  const rows = await sessions(root);
  const active = rows.find((s) => s.status === 'running' || s.status === 'stopping');
  if (active) {
    const denied = active.decisions?.deny ?? 0;
    statusBar.text = `$(shield) Nightwatch: running · ${active.actions} actions · ${denied} blocked`;
    statusBar.tooltip = `${active.id} (${active.agent})\n${active.task}`;
    statusBar.command = 'nightwatch.openDashboard';
  } else if (rows[0]) {
    statusBar.text = `$(shield) Nightwatch: ${rows[0].status}`;
    statusBar.tooltip = `${rows[0].id} — click for the report`;
    statusBar.command = 'nightwatch.openReport';
  } else {
    statusBar.text = '$(shield) Nightwatch: idle';
    statusBar.command = 'nightwatch.run';
  }
  statusBar.show();
}

function terminal(name: string, cmd: string, cwd: string): void {
  const t = vscode.window.createTerminal({ name, cwd });
  t.show();
  t.sendText(cmd);
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Nightwatch');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  context.subscriptions.push(output, statusBar);

  const register = (id: string, fn: () => Promise<void> | void) => context.subscriptions.push(vscode.commands.registerCommand(id, () => Promise.resolve(fn()).catch((e) => vscode.window.showErrorMessage(`Nightwatch: ${(e as Error).message}`))));

  register('nightwatch.init', async () => {
    const root = workspaceRoot();
    if (!root) throw new Error('open a folder first');
    const preset = await vscode.window.showQuickPick(['safe-overnight', 'balanced', 'observe'], { placeHolder: 'Policy preset' });
    if (!preset) return;
    terminal('Nightwatch', `${cfg('cliPath', 'nightwatch')} init --preset ${preset}`, root);
    setTimeout(() => void refreshStatus(), 4000);
  });

  register('nightwatch.run', async () => {
    const root = workspaceRoot();
    if (!root) throw new Error('open a folder first');
    const task = await vscode.window.showInputBox({ prompt: 'What should the agent do overnight?', placeHolder: 'Exercise the app, reproduce failures, and propose fixes' });
    if (!task) return;
    const hours = await vscode.window.showInputBox({ prompt: 'Wall-time limit (hours)', value: String(cfg('defaultHours', 8)) });
    if (!hours) return;
    const budget = await vscode.window.showInputBox({ prompt: 'Estimated spend ceiling (USD, blank for none)', value: String(cfg('defaultBudgetUsd', 5)) });
    const agent = cfg('agent', '');
    const parts = [cfg('cliPath', 'nightwatch'), 'run', '--task', quote(task), '--hours', hours];
    if (budget) parts.push('--budget-usd', budget);
    if (agent) parts.push('--agent', agent);
    terminal('Nightwatch run', parts.join(' '), root);
    startPolling();
  });

  register('nightwatch.status', async () => {
    const root = workspaceRoot();
    if (!root) return;
    const r = await cli(['status'], root);
    output.clear();
    output.appendLine(r.stdout || r.stderr);
    output.show(true);
    await refreshStatus();
  });

  register('nightwatch.stop', async () => {
    const root = workspaceRoot();
    if (!root) return;
    const ok = await vscode.window.showWarningMessage('Stop the active Nightwatch run?', { modal: true }, 'Stop');
    if (ok !== 'Stop') return;
    const r = await cli(['stop'], root);
    vscode.window.showInformationMessage(`Nightwatch: ${(r.stdout || r.stderr).trim().split('\n').pop()}`);
    await refreshStatus();
  });

  register('nightwatch.openReport', async () => {
    const root = workspaceRoot();
    if (!root) return;
    const rows = await sessions(root);
    const pick = rows.length > 1 ? await vscode.window.showQuickPick(rows.map((s) => ({ label: s.id, description: `${s.status} · ${s.agent}`, detail: s.task })), { placeHolder: 'Which run?' }) : rows[0] ? { label: rows[0].id } : undefined;
    if (!pick) {
      vscode.window.showInformationMessage('Nightwatch: no runs yet');
      return;
    }
    const r = await cli(['report', pick.label], root);
    const m = /HTML report: (.+)$/m.exec(r.stdout);
    if (!m) throw new Error(r.stderr || 'report not generated');
    const file = m[1].trim();
    const panel = vscode.window.createWebviewPanel('nightwatchReport', `Nightwatch · ${pick.label}`, vscode.ViewColumn.One, { enableScripts: false });
    panel.webview.html = fs.readFileSync(file, 'utf8');
  });

  register('nightwatch.openDashboard', async () => {
    const root = workspaceRoot();
    if (!root) return;
    const active = (await sessions(root)).find((s) => s.status === 'running' && s.port);
    if (!active) {
      vscode.window.showInformationMessage('Nightwatch: no active run with a dashboard');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${active.port}`));
  });

  register('nightwatch.policyCheck', async () => {
    const root = workspaceRoot();
    if (!root) return;
    const command = await vscode.window.showInputBox({ prompt: 'Shell command to check against the policy', placeHolder: 'rm -rf dist' });
    if (!command) return;
    const r = await cli(['policy', 'check', command], root);
    output.clear();
    output.appendLine(r.stdout || r.stderr);
    output.show(true);
  });

  register('nightwatch.openPolicy', async () => {
    const root = workspaceRoot();
    if (!root) return;
    const file = path.join(root, '.nightwatch', 'policy.yaml');
    if (!fs.existsSync(file)) throw new Error('run "Nightwatch: Initialize" first');
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  });

  void refreshStatus();
  startPolling();
}

function startPolling(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void refreshStatus(), Math.max(5, cfg('pollSeconds', 20)) * 1000);
}

export function deactivate(): void {
  if (timer) clearInterval(timer);
}

export { spawn };
