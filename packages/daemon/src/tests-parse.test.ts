import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeTestCommand, parseTestOutput } from './tests-parse.js';
import { parseStreamLine } from './stream.js';

test('detects test commands', () => {
  assert.equal(looksLikeTestCommand('npm test -- --watch=false'), true);
  assert.equal(looksLikeTestCommand('pytest tests/'), true);
  assert.equal(looksLikeTestCommand('ls -la'), false);
  assert.equal(looksLikeTestCommand('make check', 'make check'), true);
});

test('parses jest, pytest, cargo, mocha and go summaries', () => {
  assert.deepEqual(pick(parseTestOutput('npm test', 'Tests:       2 failed, 10 passed, 12 total', 1)), { ok: false, passed: 10, failed: 2 });
  assert.deepEqual(pick(parseTestOutput('pytest', '=========== 1 failed, 3 passed, 2 skipped in 0.12s ===========', 1)), { ok: false, passed: 3, failed: 1 });
  assert.deepEqual(pick(parseTestOutput('pytest', '=========== 3 passed in 0.12s ===========', 0)), { ok: true, passed: 3, failed: 0 });
  assert.deepEqual(pick(parseTestOutput('cargo test', 'test result: ok. 5 passed; 0 failed; 1 ignored; 0 measured', 0)), { ok: true, passed: 5, failed: 0 });
  assert.deepEqual(pick(parseTestOutput('npx mocha', '  3 passing (20ms)\n  1 failing', 1)), { ok: false, passed: 3, failed: 1 });
  assert.deepEqual(pick(parseTestOutput('go test ./...', 'ok  \tpkg/a\t0.1s\n--- FAIL: TestX\nFAIL\tpkg/b', 1)), { ok: false, passed: 1, failed: 1 });
  const r = parseTestOutput('npm test', '● should work\n  ✕ adds numbers', 1);
  assert.equal(r.failures.length, 2);
});

test('parses agent streams', () => {
  const claude = parseStreamLine('claude-stream-json', JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } } }));
  assert.deepEqual(claude.map((e) => e.kind), ['text', 'tool_use', 'usage']);
  const result = parseStreamLine('claude-stream-json', JSON.stringify({ type: 'result', total_cost_usd: 1.5, num_turns: 4, is_error: false, result: 'done' }));
  assert.equal(result[0].kind, 'result');
  const codex = parseStreamLine('codex-jsonl', JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } }));
  assert.deepEqual(codex[0], { kind: 'usage', input: 100, output: 20, cacheRead: 40, cacheWrite: 0, model: undefined, costUsd: undefined });
  const oc = parseStreamLine('opencode-json', JSON.stringify({ type: 'step_finish', part: { tokens: { input: 5, output: 2, cache: { read: 1, write: 0 } }, cost: 0.01 } }));
  assert.equal(oc[0].kind, 'usage');
  assert.equal(parseStreamLine('text', 'plain')[0].kind, 'text');
  assert.equal(parseStreamLine('claude-stream-json', '{not json')[0].kind, 'text');
});

function pick(r: { ok: boolean; passed: number | null; failed: number | null }) {
  return { ok: r.ok, passed: r.passed, failed: r.failed };
}
