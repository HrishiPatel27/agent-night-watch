import { spawnSync } from 'node:child_process';
import { findExecutable } from '@nightwatch-agent/daemon';
import { shellQuote } from './tool-map.js';
import { handleHook } from './run.js';

export interface ShimOutcome {
  allowed: boolean;
  realPath: string | null;
  message: string;
  exitCode: number;
}

/** Evaluate `name args…` as a Bash tool call and resolve the real binary (skipping the shim directory). */
export function shimCheck(name: string, args: string[], env: NodeJS.ProcessEnv = process.env): ShimOutcome {
  const shimDir = env.NIGHTWATCH_SHIM_DIR;
  const realPath = findExecutable(name, { skipDirs: shimDir ? [shimDir] : [], env });
  if (!realPath) return { allowed: false, realPath: null, message: `${name}: command not found`, exitCode: 127 };
  const command = [name, ...args].map(shellQuote).join(' ');
  const payload = JSON.stringify({ tool: 'Bash', input: { command }, cwd: process.cwd(), phase: 'pre' });
  const result = handleHook('generic', payload, env);
  const decision = result.decision;
  if (!result.supervised || !decision || decision.decision === 'allow') return { allowed: true, realPath, message: '', exitCode: 0 };
  return { allowed: false, realPath, message: `[Nightwatch ${decision.reasonCode}] ${decision.reason}`, exitCode: 126 };
}

/** Windows path: run the real binary from Node with inherited stdio. */
export function shimExec(name: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const check = shimCheck(name, args, env);
  if (!check.allowed || !check.realPath) {
    process.stderr.write(`${check.message}\n`);
    return check.exitCode;
  }
  const childEnv: NodeJS.ProcessEnv = { ...env };
  const pathKey = Object.keys(childEnv).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  if (env.NIGHTWATCH_ORIG_PATH) childEnv[pathKey] = env.NIGHTWATCH_ORIG_PATH;
  const r = spawnSync(check.realPath, args, { stdio: 'inherit', env: childEnv, windowsHide: true, shell: /\.(cmd|bat)$/i.test(check.realPath) });
  return r.status ?? 1;
}
