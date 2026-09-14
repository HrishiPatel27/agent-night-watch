import type { ReasonCode } from './reason-codes.js';

export type Decision = 'allow' | 'deny' | 'defer';

/**
 * observe    – record every tool call, never block.
 * guard      – enforce the policy in the user's own working tree (interactive use).
 * quarantine – enforce the policy inside a disposable git worktree (overnight runs).
 */
export type Mode = 'observe' | 'guard' | 'quarantine';

export const MODES: readonly Mode[] = ['observe', 'guard', 'quarantine'];

export interface PolicyLimits {
  wall_time_minutes: number;
  actions: number;
  consecutive_denials: number;
  /** Estimated USD ceiling; also passed to Claude Code as --max-budget-usd. */
  budget_usd?: number;
  /** Stop when the same normalised command is attempted this many times in a row. */
  repeated_command: number;
  /** Stop when no tool call has been attempted for this many minutes. */
  idle_minutes: number;
  /** Stop after this many failed test runs (0 disables). */
  failed_test_runs: number;
}

export interface PolicyAllow {
  /** Wildcard command patterns, e.g. "npm test", "git diff *". */
  commands: string[];
  /** Glob patterns of paths that may be written. Supports ${RUN_WORKTREE}, ${PROJECT_ROOT}, ~. */
  paths: string[];
  /** Glob patterns of paths that may be read (in addition to write paths). */
  read_paths: string[];
  /** Hostnames (or *.suffix) that WebFetch / curl / wget may contact. */
  domains: string[];
  /** MCP tool name patterns (mcp__server__tool) that are allowed. */
  mcp_tools: string[];
  /** Non-MCP tool names that are allowed even though Nightwatch does not model them. */
  tools: string[];
  /** Allow the built-in list of read-only / in-worktree commands. */
  builtin_safe_commands: boolean;
  /** Allow WebSearch. */
  web_search: boolean;
}

export interface PolicyDeny {
  paths: string[];
  commands: string[];
  detached_processes: boolean;
  unknown_mcp_tools: boolean;
}

export interface Policy {
  version: 1;
  name: string;
  mode: Mode;
  limits: PolicyLimits;
  allow: PolicyAllow;
  deny: PolicyDeny;
  /** What to do with commands that match neither an allow nor a deny rule. */
  unknown_commands: 'allow' | 'defer';
  /** Command used to detect and parse test runs (e.g. "npm test"). */
  test_command?: string;
  /** Extra regular expressions whose matches are redacted before persistence. */
  redact_patterns: string[];
}

// ---------------------------------------------------------------------------
// Hook payloads (Claude Code)
// ---------------------------------------------------------------------------

export type HookEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SubagentStop'
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'Notification'
  | 'PreCompact'
  | string;

export interface HookInputBase {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: HookEventName;
  permission_mode?: string;
  [key: string]: unknown;
}

export interface PreToolUseInput extends HookInputBase {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
}

export interface PostToolUseInput extends HookInputBase {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
  tool_output?: unknown;
}

export type HookInput = PreToolUseInput | PostToolUseInput | HookInputBase;

export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
  systemMessage?: string;
}

// ---------------------------------------------------------------------------
// Policy engine I/O
// ---------------------------------------------------------------------------

export interface ToolCallRequest {
  tool: string;
  input: Record<string, unknown>;
  /** Working directory the tool call will execute in. */
  cwd: string;
}

export interface BudgetState {
  actionsUsed: number;
  actionsLimit: number;
  consecutiveDenials: number;
  consecutiveDenialsLimit: number;
  /** ISO timestamp after which the run must stop. */
  deadline?: string;
  now?: string;
  spendUsd?: number;
  spendLimitUsd?: number;
  repeatedCommandCount?: number;
  repeatedCommandLimit?: number;
  stopRequested?: string;
}

export interface PolicyContext {
  policy: Policy;
  mode: Mode;
  projectRoot: string;
  /** The directory writes are confined to (the run worktree in quarantine mode, the project root in guard mode). */
  runWorktree: string;
  /** True for headless overnight runs: defer means deny. False for interactive guard mode: defer means ask. */
  unattended: boolean;
  budget?: BudgetState;
  /** Extra directories that are always writable (e.g. the OS temp dir). */
  scratchDirs?: string[];
  /** Platform override for tests. */
  platform?: NodeJS.Platform;
  homeDir?: string;
}

export interface PolicyDecision {
  decision: Decision;
  reasonCode: ReasonCode;
  /** Human readable explanation shown to the agent and in the report. */
  reason: string;
  /** Name of the rule that fired, for fixtures and debugging. */
  rule?: string;
  /** Redacted excerpt of the offending input. */
  matched?: string;
  /** Normalised view of the call, safe to persist. */
  normalized: NormalizedCall;
}

export interface NormalizedCall {
  tool: string;
  /** Short redacted summary, e.g. the command line or a file path. */
  summary: string;
  /** Canonical paths the call reads or writes. */
  paths: string[];
  /** Simple commands (argv joined) when the call is a shell command. */
  commands: string[];
  /** Hostnames the call would contact. */
  hosts: string[];
  flags: {
    background?: boolean;
    write?: boolean;
    network?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export type SessionStatus =
  | 'preflight'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'interrupted';

export interface SessionRecord {
  id: string;
  project_root: string;
  worktree: string;
  branch: string | null;
  base_ref: string | null;
  mode: Mode;
  /** Agent profile id (claude-code, codex, …) or "interactive" for guard sessions. */
  agent: string;
  task: string;
  policy_name: string;
  policy_version: string;
  policy_yaml: string;
  status: SessionStatus;
  unattended: number;
  started_at: string;
  ended_at: string | null;
  stop_reason: string | null;
  limits_json: string;
  cost_usd: number | null;
  num_turns: number | null;
  pid: number | null;
  port: number | null;
  claude_session_id: string | null;
  main_tree_fingerprint: string | null;
  main_tree_unchanged: number | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  last_activity_at: string | null;
}

export interface EventRecord {
  id: number;
  session_id: string;
  seq: number;
  event: string;
  tool: string | null;
  tool_use_id: string | null;
  input_digest: string | null;
  input_summary: string | null;
  decision: Decision | null;
  reason_code: ReasonCode | null;
  reason_text: string | null;
  rule: string | null;
  result_summary: string | null;
  result_ok: number | null;
  duration_ms: number | null;
  created_at: string;
}

export interface TestRunRecord {
  id: number;
  session_id: string;
  event_id: number | null;
  command: string;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  ok: number;
  summary: string;
  failures_json: string;
  created_at: string;
}

export interface TranscriptRecord {
  id: number;
  session_id: string;
  kind: 'assistant' | 'tool_result' | 'system' | 'result' | 'error' | 'runner';
  content: string;
  created_at: string;
}

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  id: string;
  title: string;
  severity: FindingSeverity;
  /** 0..1 */
  confidence: number;
  summary: string;
  evidence?: string;
  files?: string[];
  proposed_fix?: string;
  source: 'agent' | 'tests' | 'policy' | 'runner';
  created_at?: string;
}
