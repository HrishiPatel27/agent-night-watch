import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NightwatchStore } from '@nightwatch-agent/daemon';
import { buildReportModel, renderHtml, renderMarkdown, renderTerminal, summaryLine } from './index.js';

test('report ranks integrity, tests, agent findings and blocked actions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-report-'));
  const worktree = path.join(dir, 'wt');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, 'NIGHTWATCH_FINDINGS.jsonl'), [
    JSON.stringify({ title: 'Null deref in parser', severity: 'high', confidence: 0.8, summary: 'crashes on empty input', files: ['src/p.ts'], evidence: 'node -e ...' }),
    JSON.stringify({ title: 'Typo in README', severity: 'info', confidence: 1, summary: 'x' }),
    'not json',
  ].join('\n'));
  const store = new NightwatchStore(path.join(dir, 'db.sqlite'));
  try {
    store.createSession({ id: 's1', project_root: dir, worktree, branch: 'b', base_ref: null, mode: 'quarantine', agent: 'claude-code', task: 't', policy_name: 'p', policy_version: '1', policy_yaml: 'version: 1', unattended: true, limits: { wall_time_minutes: 60, actions: 100 }, status: 'running' });
    store.insertEvent({ session_id: 's1', event: 'PreToolUse', tool: 'Bash', input_summary: 'git push', decision: 'deny', reason_code: 'PROD_RISK', reason_text: 'push' });
    store.insertEvent({ session_id: 's1', event: 'PreToolUse', tool: 'Bash', input_summary: 'npm test', decision: 'allow', reason_code: 'EXPLICIT_ALLOW', reason_text: 'ok' });
    store.insertTestRun({ session_id: 's1', event_id: null, command: 'npm test', passed: 3, failed: 1, skipped: 0, ok: 0, summary: '3 passed, 1 failed', failures_json: JSON.stringify(['✕ adds']) });
    store.insertTranscript('s1', 'runner', 'agent=Claude Code covered=Bash|Read uncovered=OS isolation');
    store.insertTranscript('s1', 'result', 'All done.');
    store.updateSession('s1', { main_tree_unchanged: 0, cost_usd: 1.84 });
    store.setStatus('s1', 'completed', 'agent finished');
    const m = buildReportModel(store, 's1');
    assert.equal(m.health, 'red');
    assert.equal(m.findings[0].id, 'integrity');
    assert.ok(m.findings.some((f) => f.id.startsWith('tests-')));
    assert.ok(m.findings.some((f) => f.title === 'Null deref in parser'));
    assert.equal(m.skippedFindings, 1);
    assert.equal(m.blocked[0].code, 'PROD_RISK');
    assert.equal(m.coverage.covered.length, 2);
    assert.match(summaryLine(m), /2 findings · 1 test failure · 1 blocked action/);
    const html = renderHtml(m, { live: { token: 'tok' } });
    assert.match(html, /What to look at first/);
    assert.match(html, /Null deref in parser/);
    assert.ok(!html.includes('X-Nightwatch-Token'), 'finished runs do not render the stop button');
    const md = renderMarkdown(m);
    assert.match(md, /## Findings/);
    assert.match(renderTerminal(m), /Look at this first/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
