import fs from 'node:fs';
import path from 'node:path';
import {
  nowIso,
  type Decision,
  type EventRecord,
  type ReasonCode,
  type SessionRecord,
  type SessionStatus,
  type TestRunRecord,
  type TranscriptRecord,
} from '@nightwatch-agent/shared';
import { openDatabase, type DatabaseSyncLike } from './sqlite.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  worktree TEXT NOT NULL,
  branch TEXT,
  base_ref TEXT,
  mode TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'claude-code',
  task TEXT NOT NULL,
  policy_name TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  policy_yaml TEXT NOT NULL,
  status TEXT NOT NULL,
  unattended INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  stop_reason TEXT,
  limits_json TEXT NOT NULL,
  cost_usd REAL,
  num_turns INTEGER,
  pid INTEGER,
  port INTEGER,
  claude_session_id TEXT,
  main_tree_fingerprint TEXT,
  main_tree_unchanged INTEGER,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  tool TEXT,
  tool_use_id TEXT,
  input_digest TEXT,
  input_summary TEXT,
  decision TEXT,
  reason_code TEXT,
  reason_text TEXT,
  rule TEXT,
  result_summary TEXT,
  result_ok INTEGER,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS events_tool_use ON events(session_id, tool_use_id);
CREATE TABLE IF NOT EXISTS test_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_id INTEGER,
  command TEXT NOT NULL,
  passed INTEGER,
  failed INTEGER,
  skipped INTEGER,
  ok INTEGER NOT NULL,
  summary TEXT NOT NULL,
  failures_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcript (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transcript_session ON transcript(session_id, id);
`;

export interface NewSession {
  id: string;
  project_root: string;
  worktree: string;
  branch: string | null;
  base_ref: string | null;
  mode: SessionRecord['mode'];
  agent: string;
  task: string;
  policy_name: string;
  policy_version: string;
  policy_yaml: string;
  unattended: boolean;
  limits: Record<string, unknown>;
  status?: SessionStatus;
}

export interface NewEvent {
  session_id: string;
  event: string;
  tool?: string | null;
  tool_use_id?: string | null;
  input_digest?: string | null;
  input_summary?: string | null;
  decision?: Decision | null;
  reason_code?: ReasonCode | null;
  reason_text?: string | null;
  rule?: string | null;
  result_summary?: string | null;
  result_ok?: boolean | null;
  duration_ms?: number | null;
}

export interface EventQuery {
  limit?: number;
  afterSeq?: number;
  decision?: Decision;
  event?: string;
}

/**
 * Durable event store. One SQLite database per project in `.nightwatch/`.
 * Every method is synchronous so the hook adapter can persist and exit fast.
 */
export class NightwatchStore {
  private db: DatabaseSyncLike;

  constructor(public readonly file: string, options: { readOnly?: boolean } = {}) {
    if (!options.readOnly) fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = openDatabase(file, options);
    if (!options.readOnly) this.migrate();
  }

  static exists(file: string): boolean {
    return fs.existsSync(file);
  }

  private migrate(): void {
    this.db.exec(SCHEMA);
    const version = this.getMeta('schema_version');
    if (!version) this.setMeta('schema_version', '1');
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // --- sessions -------------------------------------------------------------

  createSession(s: NewSession): SessionRecord {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_root, worktree, branch, base_ref, mode, agent, task, policy_name, policy_version, policy_yaml, status, unattended, started_at, limits_json, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.project_root, s.worktree, s.branch, s.base_ref, s.mode, s.agent, s.task, s.policy_name, s.policy_version, s.policy_yaml, s.status ?? 'preflight', s.unattended ? 1 : 0, now, JSON.stringify(s.limits), now);
    return this.getSession(s.id)!;
  }

  getSession(id: string): SessionRecord | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRecord | undefined) ?? null;
  }

  /** Resolve "latest" or a unique id prefix. */
  resolveSession(ref: string | undefined): SessionRecord | null {
    if (!ref || ref === 'latest') return this.latestSession();
    const exact = this.getSession(ref);
    if (exact) return exact;
    const rows = this.db.prepare('SELECT * FROM sessions WHERE id LIKE ? ORDER BY started_at DESC').all(`${ref}%`) as SessionRecord[];
    return rows.length === 1 ? rows[0] : null;
  }

  latestSession(): SessionRecord | null {
    return (this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1').get() as SessionRecord | undefined) ?? null;
  }

  listSessions(limit = 50): SessionRecord[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit) as SessionRecord[];
  }

  activeSessions(): SessionRecord[] {
    return this.db.prepare("SELECT * FROM sessions WHERE status IN ('preflight','running','stopping') ORDER BY started_at DESC").all() as SessionRecord[];
  }

  updateSession(id: string, patch: Partial<SessionRecord>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => {
      const v = (patch as Record<string, unknown>)[k];
      return typeof v === 'boolean' ? (v ? 1 : 0) : v;
    });
    this.db.prepare(`UPDATE sessions SET ${sets} WHERE id = ?`).run(...values, id);
  }

  setStatus(id: string, status: SessionStatus, stopReason?: string): void {
    const patch: Partial<SessionRecord> = { status };
    if (stopReason !== undefined) patch.stop_reason = stopReason;
    if (status === 'completed' || status === 'stopped' || status === 'failed' || status === 'interrupted') patch.ended_at = nowIso();
    this.updateSession(id, patch);
  }

  /** Ask a running session to stop; the runner watchdog notices and terminates the agent. */
  requestStop(id: string, reason: string): boolean {
    const s = this.getSession(id);
    if (!s) return false;
    if (s.status !== 'running' && s.status !== 'preflight') return false;
    this.updateSession(id, { status: 'stopping', stop_reason: reason });
    return true;
  }

  touch(id: string): void {
    this.updateSession(id, { last_activity_at: nowIso() });
  }

  addUsage(id: string, usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; costUsd?: number; turns?: number; model?: string }): void {
    this.db
      .prepare(
        `UPDATE sessions SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ?,
         cost_usd = COALESCE(?, cost_usd), num_turns = COALESCE(?, num_turns), model = COALESCE(?, model), last_activity_at = ? WHERE id = ?`,
      )
      .run(usage.input ?? 0, usage.output ?? 0, usage.cacheRead ?? 0, usage.cacheWrite ?? 0, usage.costUsd ?? null, usage.turns ?? null, usage.model ?? null, nowIso(), id);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM events WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM test_runs WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM transcript WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  /** One-command purge of every recorded session, event and transcript. */
  purgeAll(): void {
    this.db.exec('DELETE FROM events; DELETE FROM test_runs; DELETE FROM transcript; DELETE FROM sessions;');
    this.db.exec('VACUUM');
  }

  // --- events ---------------------------------------------------------------

  insertEvent(e: NewEvent): EventRecord {
    // BEGIN IMMEDIATE serialises concurrent hook processes so seq stays unique.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE session_id = ?').get(e.session_id) as { seq: number };
      const now = nowIso();
      const res = this.db
        .prepare(
          `INSERT INTO events (session_id, seq, event, tool, tool_use_id, input_digest, input_summary, decision, reason_code, reason_text, rule, result_summary, result_ok, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          e.session_id,
          row.seq,
          e.event,
          e.tool ?? null,
          e.tool_use_id ?? null,
          e.input_digest ?? null,
          e.input_summary ?? null,
          e.decision ?? null,
          e.reason_code ?? null,
          e.reason_text ?? null,
          e.rule ?? null,
          e.result_summary ?? null,
          e.result_ok == null ? null : e.result_ok ? 1 : 0,
          e.duration_ms ?? null,
          now,
        );
      this.db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(now, e.session_id);
      this.db.exec('COMMIT');
      return this.getEvent(Number(res.lastInsertRowid))!;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  getEvent(id: number): EventRecord | null {
    return (this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRecord | undefined) ?? null;
  }

  updateEvent(id: number, patch: Partial<EventRecord>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db.prepare(`UPDATE events SET ${sets} WHERE id = ?`).run(...keys.map((k) => (patch as Record<string, unknown>)[k]), id);
  }

  listEvents(sessionId: string, q: EventQuery = {}): EventRecord[] {
    const where: string[] = ['session_id = ?'];
    const params: unknown[] = [sessionId];
    if (q.afterSeq != null) {
      where.push('seq > ?');
      params.push(q.afterSeq);
    }
    if (q.decision) {
      where.push('decision = ?');
      params.push(q.decision);
    }
    if (q.event) {
      where.push('event = ?');
      params.push(q.event);
    }
    const limit = q.limit ?? 5000;
    return this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?`).all(...params, limit) as EventRecord[];
  }

  /** Most recent PreToolUse event for a tool_use_id (to pair with PostToolUse). */
  findPreEvent(sessionId: string, toolUseId: string | null, tool: string | null): EventRecord | null {
    if (toolUseId) {
      const row = this.db.prepare("SELECT * FROM events WHERE session_id = ? AND tool_use_id = ? AND event = 'PreToolUse' ORDER BY seq DESC LIMIT 1").get(sessionId, toolUseId) as EventRecord | undefined;
      if (row) return row;
    }
    if (tool) {
      return (
        (this.db
          .prepare("SELECT * FROM events WHERE session_id = ? AND tool = ? AND event = 'PreToolUse' AND result_summary IS NULL ORDER BY seq DESC LIMIT 1")
          .get(sessionId, tool) as EventRecord | undefined) ?? null
      );
    }
    return null;
  }

  countActions(sessionId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND event = 'PreToolUse'").get(sessionId) as { n: number };
    return Number(row.n);
  }

  countByDecision(sessionId: string): Record<string, number> {
    const rows = this.db.prepare("SELECT decision, COUNT(*) AS n FROM events WHERE session_id = ? AND event = 'PreToolUse' GROUP BY decision").all(sessionId) as { decision: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.decision ?? 'none'] = Number(r.n);
    return out;
  }

  consecutiveDenials(sessionId: string): number {
    const rows = this.db.prepare("SELECT decision FROM events WHERE session_id = ? AND event = 'PreToolUse' ORDER BY seq DESC LIMIT 50").all(sessionId) as { decision: string }[];
    let n = 0;
    for (const r of rows) {
      if (r.decision === 'deny' || r.decision === 'defer') n++;
      else break;
    }
    return n;
  }

  /** How many times in a row the most recent input digest was attempted. */
  repeatedCommandCount(sessionId: string, digest: string): number {
    const rows = this.db.prepare("SELECT input_digest FROM events WHERE session_id = ? AND event = 'PreToolUse' ORDER BY seq DESC LIMIT 100").all(sessionId) as { input_digest: string }[];
    let n = 0;
    for (const r of rows) {
      if (r.input_digest === digest) n++;
      else break;
    }
    return n;
  }

  // --- test runs & transcript -------------------------------------------------

  insertTestRun(t: Omit<TestRunRecord, 'id' | 'created_at'>): void {
    this.db
      .prepare('INSERT INTO test_runs (session_id, event_id, command, passed, failed, skipped, ok, summary, failures_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.session_id, t.event_id, t.command, t.passed, t.failed, t.skipped, t.ok ? 1 : 0, t.summary, t.failures_json, nowIso());
  }

  listTestRuns(sessionId: string): TestRunRecord[] {
    return this.db.prepare('SELECT * FROM test_runs WHERE session_id = ? ORDER BY id ASC').all(sessionId) as TestRunRecord[];
  }

  countFailedTestRuns(sessionId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM test_runs WHERE session_id = ? AND ok = 0').get(sessionId) as { n: number };
    return Number(row.n);
  }

  insertTranscript(sessionId: string, kind: TranscriptRecord['kind'], content: string): void {
    this.db.prepare('INSERT INTO transcript (session_id, kind, content, created_at) VALUES (?, ?, ?, ?)').run(sessionId, kind, content, nowIso());
  }

  listTranscript(sessionId: string, limit = 2000): TranscriptRecord[] {
    return this.db.prepare('SELECT * FROM transcript WHERE session_id = ? ORDER BY id ASC LIMIT ?').all(sessionId, limit) as TranscriptRecord[];
  }
}
