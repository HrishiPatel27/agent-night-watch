import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { findProjectRoot, nightwatchPaths, type NightwatchPaths } from '@nightwatch-agent/shared';
import { loadConfig, repoRoot, type HookCommand, type NightwatchConfig } from '@nightwatch-agent/daemon';
import { loadPolicyFile, safeOvernightPreset, type LoadedPolicy } from '@nightwatch-agent/policy';

export class CliError extends Error {
  constructor(message: string, public readonly exitCode = 1) {
    super(message);
    this.name = 'CliError';
  }
}

export interface Project {
  root: string;
  paths: NightwatchPaths;
  config: NightwatchConfig;
}

/** Resolve the project root: --project, then the nearest .nightwatch/ or git root above cwd. */
export function resolveProject(explicit?: string, { requireInit = true } = {}): Project {
  const start = explicit ? path.resolve(explicit) : process.cwd();
  const root = findProjectRoot(start) ?? repoRoot(start) ?? (explicit ? start : null);
  if (!root) throw new CliError('not inside a git repository; run "git init" or pass --project <dir>');
  const paths = nightwatchPaths(root);
  if (requireInit && !fs.existsSync(paths.policy)) throw new CliError(`Nightwatch is not initialised in ${root}; run "nightwatch init" first`);
  return { root, paths, config: loadConfig(root) };
}

export function loadPolicyFor(p: Project, file?: string): LoadedPolicy {
  const f = file ? path.resolve(file) : p.paths.policy;
  if (!fs.existsSync(f)) {
    if (file) throw new CliError(`policy file not found: ${f}`);
    const preset = safeOvernightPreset();
    return { policy: preset, yaml: '', warnings: ['no policy.yaml found; using the safe-overnight preset'] };
  }
  return loadPolicyFile(f);
}

/** Locate the hook entry script shipped with @nightwatch-agent/hook. */
export function resolveHookCommand(): HookCommand {
  const require = createRequire(import.meta.url);
  const index = require.resolve('@nightwatch-agent/hook');
  const script = path.join(path.dirname(index), 'bin.js');
  if (!fs.existsSync(script)) throw new CliError(`hook entry script not found at ${script}; reinstall nightwatch-agent`);
  return { node: process.execPath, script };
}

export const out = {
  info: (s: string) => process.stdout.write(`${s}\n`),
  ok: (s: string) => process.stdout.write(`✓ ${s}\n`),
  warn: (s: string) => process.stdout.write(`! ${s}\n`),
  fail: (s: string) => process.stderr.write(`✗ ${s}\n`),
  json: (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`),
};

export function ago(iso: string | null): string {
  if (!iso) return '–';
  const ms = Date.now() - Date.parse(iso);
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
