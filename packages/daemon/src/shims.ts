import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from '@nightwatch-agent/shared';
import type { HookCommand } from './agents.js';

/**
 * PATH shim guard. Each shim evaluates the command through the Nightwatch
 * policy (as a Bash tool call) and then runs the real binary. It is the
 * universal fallback for agents without pre-execution hooks; coverage is
 * partial by nature (absolute paths and shell builtins bypass it).
 */
export function createShims(runDir: string, commands: string[], hc: HookCommand): { dir: string; count: number } {
  const dir = path.join(runDir, 'shims');
  fs.mkdirSync(dir, { recursive: true });
  let count = 0;
  for (const name of commands) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) continue;
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n"${hc.node}" "${hc.script}" shim-exec ${name} %*\r\nexit /b %ERRORLEVEL%\r\n`);
    } else {
      const body = `#!/bin/sh
# Nightwatch guard shim for "${name}": policy check first, then the real binary.
# Descendants run with the original PATH: the policy judges the command the agent issued, like a hook does.
NW_REAL=$("${toPosix(hc.node)}" "${toPosix(hc.script)}" shim-check ${name} "$@") || exit $?
if [ -n "$NIGHTWATCH_ORIG_PATH" ]; then PATH="$NIGHTWATCH_ORIG_PATH"; export PATH; fi
exec "$NW_REAL" "$@"
`;
      fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
    }
    count++;
  }
  return { dir, count };
}

export function shimEnv(shimDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return { [key]: `${shimDir}${path.delimiter}${env[key] ?? ''}`, NIGHTWATCH_ORIG_PATH: env[key] ?? '', NIGHTWATCH_SHIM_DIR: shimDir, NIGHTWATCH_SHIM_GUARD: '1' };
}
