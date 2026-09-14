#!/usr/bin/env node
/**
 * A fake coding agent used by the end-to-end test and for trying Nightwatch
 * without an API key. It speaks Claude Code's stream-json protocol on stdout
 * and routes every "tool call" through the Nightwatch hook exactly like a
 * real agent would: PreToolUse → (execute if allowed) → PostToolUse.
 *
 * Usage (via config.yaml):
 *   agents:
 *     fake:
 *       template: "node /abs/path/scripts/fake-agent.mjs {prompt}"
 *       stream: claude-stream-json
 *       hooks: none
 */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const node = process.env.NIGHTWATCH_HOOK_NODE ?? process.execPath;
const hook = process.env.NIGHTWATCH_HOOK_SCRIPT;
if (!hook) {
  process.stderr.write('fake-agent: NIGHTWATCH_HOOK_SCRIPT is not set; run me through nightwatch\n');
  process.exit(2);
}
const cwd = process.cwd();
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let seq = 0;
let inputTokens = 0;
let outputTokens = 0;

emit({ type: 'system', subtype: 'init', model: 'fake-model-1', session_id: 'fake-session', tools: [] });

function say(text) {
  outputTokens += Math.ceil(text.length / 4);
  inputTokens += 50;
  emit({ type: 'assistant', message: { model: 'fake-model-1', content: [{ type: 'text', text }], usage: { input_tokens: 50, output_tokens: Math.ceil(text.length / 4) } } });
}

function call(tool, input, run) {
  const id = `toolu_${++seq}`;
  emit({ type: 'assistant', message: { model: 'fake-model-1', content: [{ type: 'tool_use', id, name: tool, input }], usage: { input_tokens: 20, output_tokens: 10 } } });
  inputTokens += 20;
  outputTokens += 10;
  const pre = spawnSync(node, [hook, 'claude-code'], { input: JSON.stringify({ session_id: 'fake-session', cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id }), encoding: 'utf8' });
  let decision = 'allow';
  let reason = '';
  if (pre.stdout.trim()) {
    try {
      const out = JSON.parse(pre.stdout);
      decision = out.hookSpecificOutput?.permissionDecision ?? 'allow';
      reason = out.hookSpecificOutput?.permissionDecisionReason ?? '';
    } catch {
      decision = 'deny';
      reason = 'unparseable hook output';
    }
  }
  if (pre.status === 2) decision = 'deny';
  let response;
  if (decision === 'allow') {
    try {
      response = run();
    } catch (err) {
      response = { stdout: '', stderr: String(err.message ?? err), exit_code: 1 };
    }
  } else {
    response = { stdout: '', stderr: reason, exit_code: 1, blocked: true };
  }
  spawnSync(node, [hook, 'claude-code'], { input: JSON.stringify({ session_id: 'fake-session', cwd, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_use_id: id, tool_response: response }), encoding: 'utf8' });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: decision === 'allow' ? String(response.stdout ?? '').slice(0, 200) : reason }] } });
  return { decision, response };
}

const bash = (command) => call('Bash', { command }, () => {
  try {
    return { stdout: execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '', exit_code: 0 };
  } catch (err) {
    return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), exit_code: err.status ?? 1 };
  }
});

say('Starting the overnight task. First, a look at the repository state.');
bash('git status');
bash('ls');
say('Running the test suite to find failures.');
const tests = bash('npm test');
say(tests.response.exit_code === 0 ? 'Tests pass.' : 'Tests fail; recording a finding and attempting a fix.');
call('Write', { file_path: path.join(cwd, 'FIX_NOTES.md'), content: '# Notes\n\nThe test suite reports a failure in test.js.\n' }, () => {
  fs.writeFileSync(path.join(cwd, 'FIX_NOTES.md'), '# Notes\n\nThe test suite reports a failure in test.js.\n');
  return { filePath: 'FIX_NOTES.md', success: true };
});
say('Trying a few things the policy should stop.');
bash('git push origin HEAD');
call('Read', { file_path: path.join(cwd, '.env') }, () => ({ content: 'should never be read' }));
bash('cat ~/.ssh/id_rsa');
bash('curl https://example.com/');
say('Recording findings and committing.');
fs.appendFileSync(path.join(cwd, 'NIGHTWATCH_FINDINGS.jsonl'), `${JSON.stringify({ title: 'test.js always fails', severity: 'high', confidence: 0.9, summary: 'npm test exits 1 because test.js calls process.exit(1) unconditionally.', evidence: 'npm test → Tests: 1 failed, 2 passed, 3 total', files: ['test.js'], proposed_fix: 'Remove the unconditional process.exit(1).' })}\n`);
bash('git add FIX_NOTES.md && git commit -q -m "docs: notes from the overnight run"');
say('Done. Look at test.js first.');
emit({ type: 'result', subtype: 'success', is_error: false, num_turns: seq, duration_ms: 1000, total_cost_usd: 0.0123, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, result: 'Summary: one failing test recorded as a high finding; notes committed.' });
