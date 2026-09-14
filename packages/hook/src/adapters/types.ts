import type { Decision, ReasonCode } from '@nightwatch-agent/shared';

export type J = Record<string, unknown>;

export interface NormalizedHook {
  phase: 'pre' | 'post' | 'other';
  /** Original event name from the agent. */
  event: string;
  /** Canonical tool name (Bash, Read, Write, mcp__server__tool, …). */
  tool?: string;
  input?: J;
  toolUseId?: string;
  cwd?: string;
  /** Post-phase tool output/response. */
  response?: unknown;
  agentSessionId?: string;
}

export interface HookResponse {
  stdout: string;
  stderr?: string;
  exitCode: number;
}

export interface Adapter {
  id: string;
  /** Whether this adapter recognises the payload (used by "auto"). */
  detect(raw: J): boolean;
  normalize(raw: J): NormalizedHook;
  respond(decision: Decision, reasonCode: ReasonCode, reason: string, hook: NormalizedHook): HookResponse;
}

export const ALLOW: HookResponse = { stdout: '', exitCode: 0 };

export function denyText(reasonCode: ReasonCode, reason: string): string {
  return `[Nightwatch ${reasonCode}] ${reason}`;
}
