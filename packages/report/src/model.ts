import fs from 'node:fs';
import { changedFiles, commitLog, diffStat, fileDiff, readAgentFindings, type ChangedFile, NightwatchStore } from '@nightwatch-agent/daemon';
import { FINDINGS_FILE, formatDuration, formatUsd, plural, runPaths, type EventRecord, type Finding, type FindingSeverity, type SessionRecord, type TestRunRecord } from '@nightwatch-agent/shared';

export interface RankedFinding extends Finding {
  score: number;
}

export interface LookFirstItem {
  kind: 'finding' | 'tests' | 'blocked' | 'integrity' | 'run' | 'changes';
  title: string;
  detail: string;
}

export interface BlockedGroup {
  code: string;
  count: number;
  examples: EventRecord[];
}

export interface ReportModel {
  generatedAt: string;
  session: SessionRecord;
  live: boolean;
  headline: string;
  health: 'green' | 'yellow' | 'red';
  healthReasons: string[];
  lookFirst: LookFirstItem[];
  findings: RankedFinding[];
  skippedFindings: number;
  tests: { runs: TestRunRecord[]; failing: TestRunRecord[]; latest: TestRunRecord | null };
  blocked: BlockedGroup[];
  counts: { actions: number; allowed: number; denied: number; deferred: number };
  changes: { worktreeExists: boolean; files: ChangedFile[]; commits: { sha: string; subject: string }[]; diffStat: string; patchFile: string | null; previews: { path: string; diff: string }[] };
  timeline: EventRecord[];
  usage: { durationMs: number; costUsd: number | null; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; model: string | null; turns: number | null };
  coverage: { covered: string[]; uncovered: string[] };
  summaryText: string | null;
  errors: string[];
  policy: { name: string; version: string; yaml: string };
  mainTreeUnchanged: boolean | null;
}

const SEVERITY_WEIGHT: Record<FindingSeverity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

export function scoreFinding(f: Finding): number {
  return SEVERITY_WEIGHT[f.severity] * (0.5 + 0.5 * f.confidence);
}

export interface ModelOptions {
  /** Include per-file diff previews (slower on large diffs). */
  previews?: boolean;
  maxTimeline?: number;
}

export function buildReportModel(store: NightwatchStore, sessionId: string, opts: ModelOptions = {}): ReportModel {
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  const live = session.status === 'running' || session.status === 'stopping' || session.status === 'preflight';
  const events = store.listEvents(sessionId, { limit: 100_000 });
  const pre = events.filter((e) => e.event === 'PreToolUse');
  const counts = {
    actions: pre.length,
    allowed: pre.filter((e) => e.decision === 'allow').length,
    denied: pre.filter((e) => e.decision === 'deny').length,
    deferred: pre.filter((e) => e.decision === 'defer').length,
  };
  const testRuns = store.listTestRuns(sessionId);
  const failing = testRuns.filter((t) => !t.ok);
  const transcript = store.listTranscript(sessionId, 5000);
  const errors = transcript.filter((t) => t.kind === 'error').map((t) => t.content);
  const resultText = [...transcript].reverse().find((t) => t.kind === 'result' && t.content.trim())?.content ?? null;
  const lastAssistant = [...transcript].reverse().find((t) => t.kind === 'assistant')?.content ?? null;
  const coverage = parseCoverage(transcript.map((t) => t.content));

  // Findings
  const findings: RankedFinding[] = [];
  let skippedFindings = 0;
  const worktreeExists = !!session.worktree && fs.existsSync(session.worktree);
  if (worktreeExists) {
    const agent = readAgentFindings(session.worktree);
    skippedFindings = agent.skipped;
    for (const f of agent.findings) findings.push({ ...f, score: scoreFinding(f) });
  }
  if (session.main_tree_unchanged === 0) {
    findings.push(rank({ id: 'integrity', title: 'The main working tree changed during the run', severity: 'critical', confidence: 1, summary: 'Nightwatch fingerprints HEAD, the index, tracked modifications and untracked files before and after the run. They differ. Review `git status` in the main tree before trusting anything else in this report.', source: 'runner' }));
  }
  if (session.status === 'failed' || session.status === 'interrupted') {
    findings.push(rank({ id: 'run-status', title: `Run ${session.status}${session.stop_reason ? `: ${session.stop_reason}` : ''}`, severity: 'high', confidence: 0.9, summary: errors.length ? `Errors recorded: ${errors.slice(0, 3).join(' | ')}` : 'The agent did not finish cleanly. Check the run log and transcript.', source: 'runner' }));
  }
  const latestByCommand = new Map<string, TestRunRecord>();
  for (const t of testRuns) latestByCommand.set(t.command, t);
  for (const t of latestByCommand.values()) {
    if (t.ok) continue;
    let fails: string[] = [];
    try {
      fails = JSON.parse(t.failures_json) as string[];
    } catch {
      /* ignore */
    }
    findings.push(rank({ id: `tests-${t.id}`, title: `Tests failing: ${t.command} (${t.summary})`, severity: 'high', confidence: 0.9, summary: `The most recent run of this command failed${t.failed != null ? ` with ${plural(t.failed, 'failure')}` : ''}.`, evidence: fails.slice(0, 15).join('\n') || undefined, source: 'tests' }));
  }
  const hardCodes = ['SECRET_PATH', 'DESTRUCTIVE_COMMAND', 'PROD_RISK', 'SUPERVISOR_TAMPER'];
  const hardDenied = pre.filter((e) => e.decision === 'deny' && hardCodes.includes(e.reason_code ?? ''));
  if (hardDenied.length) {
    const codes = [...new Set(hardDenied.map((e) => e.reason_code))].join(', ');
    findings.push(rank({ id: 'blocked-hard', title: `${plural(hardDenied.length, 'blocked high-risk action')} (${codes})`, severity: hardDenied.length > 5 ? 'medium' : 'low', confidence: 1, summary: 'The agent tried actions the policy classifies as secret access, destructive, production-affecting or supervisor tampering. See "Blocked and deferred actions" for each attempt. Repeated attempts usually mean the task needs a narrower brief or an explicit allow rule.', evidence: hardDenied.slice(0, 5).map((e) => `${e.tool}: ${e.input_summary ?? ''} → ${e.reason_code}`).join('\n'), source: 'policy' }));
  }
  if (session.stop_reason && /limit|denials|ceiling|activity|failed test/i.test(session.stop_reason) && session.status === 'stopped') {
    findings.push(rank({ id: 'budget', title: `Stopped by a budget rule: ${session.stop_reason}`, severity: 'low', confidence: 1, summary: 'The run ended because a configured limit was reached, not because the agent finished. Consider raising the limit or narrowing the task.', source: 'runner' }));
  }
  findings.sort((a, b) => b.score - a.score);

  // Blocked groups
  const groups = new Map<string, BlockedGroup>();
  for (const e of pre) {
    if (e.decision !== 'deny' && e.decision !== 'defer') continue;
    const code = e.reason_code ?? 'UNKNOWN';
    const g = groups.get(code) ?? { code, count: 0, examples: [] };
    g.count++;
    if (g.examples.length < 8) g.examples.push(e);
    groups.set(code, g);
  }
  const blocked = [...groups.values()].sort((a, b) => hardCodes.indexOf(a.code) === -1 ? 1 : -1 || b.count - a.count);

  // Changes
  const changes: ReportModel['changes'] = { worktreeExists, files: [], commits: [], diffStat: '', patchFile: null, previews: [] };
  if (worktreeExists && session.base_ref && session.mode === 'quarantine') {
    try {
      const exclude = [FINDINGS_FILE];
      changes.files = changedFiles(session.worktree, session.base_ref, exclude);
      changes.commits = commitLog(session.worktree, session.base_ref);
      changes.diffStat = diffStat(session.worktree, session.base_ref, exclude);
      const rp = runPaths(session.project_root, session.id);
      if (fs.existsSync(rp.patch)) changes.patchFile = rp.patch;
      if (opts.previews !== false) {
        for (const f of changes.files.slice(0, 8)) {
          const d = fileDiff(session.worktree, session.base_ref, f.path, 40_000);
          if (d.trim()) changes.previews.push({ path: f.path, diff: d.split('\n').slice(0, 120).join('\n') });
        }
      }
    } catch {
      /* worktree may be in a bad state; leave empty */
    }
  }

  // Usage
  const endedAt = session.ended_at ? Date.parse(session.ended_at) : Date.now();
  const usage: ReportModel['usage'] = {
    durationMs: endedAt - Date.parse(session.started_at),
    costUsd: session.cost_usd,
    tokens: { input: session.input_tokens, output: session.output_tokens, cacheRead: session.cache_read_tokens, cacheWrite: session.cache_write_tokens },
    model: session.model,
    turns: session.num_turns,
  };

  // Health & headline
  const healthReasons: string[] = [];
  let health: ReportModel['health'] = 'green';
  const bump = (level: ReportModel['health'], why: string) => {
    healthReasons.push(why);
    if (level === 'red' || (level === 'yellow' && health === 'green')) health = level;
  };
  if (session.main_tree_unchanged === 0) bump('red', 'main tree changed');
  if (session.status === 'failed' || session.status === 'interrupted') bump('red', `run ${session.status}`);
  if (findings.some((f) => f.severity === 'critical' && f.source === 'agent')) bump('red', 'critical finding');
  if (failing.length) bump('yellow', `${plural(failing.length, 'failing test run')}`);
  if (findings.some((f) => f.severity === 'high' && f.source === 'agent')) bump('yellow', 'high-severity finding');
  if (hardDenied.length) bump('yellow', `${plural(hardDenied.length, 'high-risk action')} blocked`);
  if (session.status === 'stopped') bump('yellow', `stopped: ${session.stop_reason ?? 'unknown reason'}`);
  if (live) bump('yellow', 'still running');
  const agentFindings = findings.filter((f) => f.source === 'agent');
  const statusWord = live ? 'Running' : session.status === 'completed' ? 'Completed' : session.status === 'stopped' ? 'Stopped' : session.status === 'failed' ? 'Failed' : 'Interrupted';
  const headline = `${statusWord} after ${formatDuration(usage.durationMs)}: ${plural(agentFindings.length, 'finding')}${agentFindings.length ? ` (${summarizeSeverities(agentFindings)})` : ''}, ${plural(failing.length, 'failing test run')}, ${plural(counts.denied + counts.deferred, 'blocked action')}, ${plural(changes.files.length, 'changed file')}, ${formatUsd(usage.costUsd)} estimated.`;

  // Look first
  const lookFirst: LookFirstItem[] = [];
  if (session.main_tree_unchanged === 0) lookFirst.push({ kind: 'integrity', title: 'Main tree integrity check failed', detail: 'Review git status in your main working tree before anything else.' });
  if (session.status === 'failed' || session.status === 'interrupted') lookFirst.push({ kind: 'run', title: `Run ${session.status}`, detail: session.stop_reason ?? errors[0] ?? 'see run log' });
  for (const f of findings.filter((f) => f.source === 'agent').slice(0, 3)) lookFirst.push({ kind: 'finding', title: `${f.severity.toUpperCase()} · ${f.title}`, detail: f.summary.slice(0, 220) });
  if (failing.length && lookFirst.length < 4) lookFirst.push({ kind: 'tests', title: `${plural(failing.length, 'failing test run')}`, detail: failing.slice(-1)[0].command + ' → ' + failing.slice(-1)[0].summary });
  if (hardDenied.length && lookFirst.length < 4) lookFirst.push({ kind: 'blocked', title: `${plural(hardDenied.length, 'high-risk action')} blocked`, detail: [...new Set(hardDenied.map((e) => e.reason_code))].join(', ') });
  if (changes.files.length && lookFirst.length < 4) lookFirst.push({ kind: 'changes', title: `${plural(changes.files.length, 'changed file')} in ${plural(changes.commits.length, 'commit')}`, detail: changes.files.slice(0, 5).map((f) => f.path).join(', ') });
  if (!lookFirst.length) lookFirst.push({ kind: 'run', title: live ? 'Nothing to review yet' : 'Nothing needs attention', detail: live ? 'The agent is still working.' : 'No findings, no failing tests, no blocked actions and no changes were recorded.' });

  return {
    generatedAt: new Date().toISOString(),
    session,
    live,
    headline,
    health,
    healthReasons,
    lookFirst: lookFirst.slice(0, 4),
    findings,
    skippedFindings,
    tests: { runs: testRuns, failing, latest: testRuns.length ? testRuns[testRuns.length - 1] : null },
    blocked,
    counts,
    changes,
    timeline: events.slice(-(opts.maxTimeline ?? 400)),
    usage,
    coverage,
    summaryText: resultText ?? lastAssistant,
    errors,
    policy: { name: session.policy_name, version: session.policy_version, yaml: session.policy_yaml },
    mainTreeUnchanged: session.main_tree_unchanged == null ? null : session.main_tree_unchanged === 1,
  };
}

function rank(f: Finding): RankedFinding {
  return { ...f, score: scoreFinding(f) };
}

function summarizeSeverities(fs: Finding[]): string {
  const c: Partial<Record<FindingSeverity, number>> = {};
  for (const f of fs) c[f.severity] = (c[f.severity] ?? 0) + 1;
  return (['critical', 'high', 'medium', 'low', 'info'] as FindingSeverity[]).filter((s) => c[s]).map((s) => `${c[s]} ${s}`).join(', ');
}

function parseCoverage(lines: string[]): { covered: string[]; uncovered: string[] } {
  for (const l of lines) {
    const m = /covered=(.*?) uncovered=(.*)$/.exec(l);
    if (m) return { covered: m[1].split('|').filter(Boolean), uncovered: m[2].split('|').filter(Boolean) };
  }
  return { covered: [], uncovered: [] };
}

export function summaryLine(m: ReportModel): string {
  const agentFindings = m.findings.filter((f) => f.source === 'agent').length;
  return `${plural(agentFindings, 'finding')} · ${plural(m.tests.failing.length, 'test failure')} · ${plural(m.counts.denied + m.counts.deferred, 'blocked action')} · ${plural(m.changes.files.length, 'changed file')} · ${formatUsd(m.usage.costUsd)} estimated usage`;
}
