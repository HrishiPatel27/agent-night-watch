/**
 * Reason codes are the only vocabulary the policy engine uses to explain a
 * decision. They are stable identifiers: reports, fixtures and the dashboard
 * key off them, so add new ones but never rename existing ones.
 */
export const REASON_CODES = [
  // Hard denies (precedence 1)
  'SECRET_PATH',
  'OUTSIDE_WORKTREE',
  'DESTRUCTIVE_COMMAND',
  'PROD_RISK',
  'NETWORK_NOT_ALLOWED',
  'DETACHED_PROCESS',
  'SUPERVISOR_TAMPER',
  // Budget stops (precedence 2)
  'BUDGET_EXCEEDED',
  // Unknowns (precedence 4)
  'UNKNOWN_TOOL',
  'UNKNOWN_COMMAND',
  // Fail-closed conditions raised by the hook adapter itself
  'MALFORMED_INPUT',
  'PATH_UNRESOLVED',
  'SESSION_INACTIVE',
  // Allow reasons (informational)
  'EXPLICIT_ALLOW',
  'BUILTIN_SAFE',
  'IN_WORKTREE',
  'OBSERVE_ONLY',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export const REASON_TEXT: Record<ReasonCode, string> = {
  SECRET_PATH: 'Touches a credential or secret path',
  OUTSIDE_WORKTREE: 'Reads or writes outside the permitted directories',
  DESTRUCTIVE_COMMAND: 'Matches a destructive or privilege-escalating command pattern',
  PROD_RISK: 'Could affect production, deployments, releases or databases',
  NETWORK_NOT_ALLOWED: 'Network destination is not on the allow list',
  DETACHED_PROCESS: 'Would start a detached or background process the supervisor cannot see',
  SUPERVISOR_TAMPER: 'Would modify or disable Nightwatch supervision',
  BUDGET_EXCEEDED: 'A configured budget or stop condition was reached',
  UNKNOWN_TOOL: 'Tool is not recognised and unknown tools are blocked in unattended mode',
  UNKNOWN_COMMAND: 'Command is not on the allow list and unknown commands are deferred',
  MALFORMED_INPUT: 'Hook payload could not be parsed; failing closed',
  PATH_UNRESOLVED: 'Path could not be canonicalised; failing closed',
  SESSION_INACTIVE: 'No active guarded session; failing closed',
  EXPLICIT_ALLOW: 'Matches an explicit allow rule',
  BUILTIN_SAFE: 'Recognised read-only or in-worktree command',
  IN_WORKTREE: 'Path is inside the permitted directories',
  OBSERVE_ONLY: 'Observe mode: recorded, not enforced',
};

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === 'string' && (REASON_CODES as readonly string[]).includes(value);
}
