#!/usr/bin/env node
/**
 * Nightwatch hook entry point.
 *   node bin.js <adapter>              read one hook payload from stdin, print the decision
 *   node bin.js shim-check <cmd> args… policy check for a PATH shim; prints the real binary path
 *   node bin.js shim-exec <cmd> args…  policy check, then run the real binary (Windows shims)
 *   node bin.js --selftest             verify the adapter can load its dependencies
 * Adapters: claude-code | codex | grok | cursor | gemini-cli | copilot-cli | opencode | amp | generic | auto
 */
import { handleHook } from './run.js';
import { shimCheck, shimExec } from './shim.js';

async function readStdin(timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function main(): Promise<number> {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === '--selftest') {
    process.stdout.write('nightwatch hook ok\n');
    return 0;
  }
  if (mode === 'shim-check') {
    const [name, ...args] = rest;
    const r = shimCheck(name, args);
    if (r.allowed && r.realPath) {
      process.stdout.write(`${r.realPath}\n`);
      return 0;
    }
    process.stderr.write(`${r.message}\n`);
    return r.exitCode;
  }
  if (mode === 'shim-exec') {
    const [name, ...args] = rest;
    return shimExec(name, args);
  }
  const stdin = await readStdin();
  const result = handleHook(mode ?? 'auto', stdin);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  return result.exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // Absolute last resort: fail closed in Claude's format.
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[Nightwatch MALFORMED_INPUT] hook crashed: ${(err as Error).message}` } }));
    process.stderr.write(`[Nightwatch] hook crashed: ${(err as Error).message}\n`);
    process.exitCode = 2;
  });
