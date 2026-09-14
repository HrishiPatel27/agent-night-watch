import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NightwatchStore } from './store.js';

function tmpStore(): { store: NightwatchStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-store-'));
  return { store: new NightwatchStore(path.join(dir, '.nightwatch', 'nightwatch.db')), dir };
}

test('sessions and events round trip with monotonically increasing seq', () => {
  const { store, dir } = tmpStore();
  try {
    const s = store.createSession({
      id: 's1',
      project_root: dir,
      worktree: path.join(dir, 'wt'),
      branch: 'nightwatch/s1',
      base_ref: 'abc',
      mode: 'quarantine',
      agent: 'claude-code',
      task: 'do things',
      policy_name: 'safe-overnight',
      policy_version: '1',
      policy_yaml: 'version: 1',
      unattended: true,
      limits: { actions: 10 },
    });
    assert.equal(s.status, 'preflight');
    store.setStatus('s1', 'running');
    const e1 = store.insertEvent({ session_id: 's1', event: 'PreToolUse', tool: 'Bash', tool_use_id: 't1', decision: 'allow', input_digest: 'd1' });
    const e2 = store.insertEvent({ session_id: 's1', event: 'PreToolUse', tool: 'Bash', tool_use_id: 't2', decision: 'deny', reason_code: 'PROD_RISK', input_digest: 'd2' });
    const e3 = store.insertEvent({ session_id: 's1', event: 'PreToolUse', tool: 'Read', tool_use_id: 't3', decision: 'deny', reason_code: 'SECRET_PATH', input_digest: 'd2' });
    assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3]);
    assert.equal(store.countActions('s1'), 3);
    assert.equal(store.consecutiveDenials('s1'), 2);
    assert.equal(store.repeatedCommandCount('s1', 'd2'), 2);
    assert.deepEqual(store.countByDecision('s1'), { allow: 1, deny: 2 });
    const pre = store.findPreEvent('s1', 't2', 'Bash');
    assert.equal(pre?.id, e2.id);
    store.updateEvent(e2.id, { result_summary: 'blocked', result_ok: 0, duration_ms: 5 });
    assert.equal(store.getEvent(e2.id)?.result_summary, 'blocked');
    assert.equal(store.requestStop('s1', 'manual'), true);
    assert.equal(store.getSession('s1')?.status, 'stopping');
    assert.equal(store.resolveSession('latest')?.id, 's1');
    assert.equal(store.resolveSession('s')?.id, 's1');
    store.addUsage('s1', { input: 10, output: 5, costUsd: 0.5, model: 'm' });
    assert.equal(store.getSession('s1')?.input_tokens, 10);
    store.insertTestRun({ session_id: 's1', event_id: e1.id, command: 'npm test', passed: 1, failed: 2, skipped: 0, ok: 0, summary: '2 failed', failures_json: '[]' });
    assert.equal(store.countFailedTestRuns('s1'), 1);
    store.purgeAll();
    assert.equal(store.listSessions().length, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
