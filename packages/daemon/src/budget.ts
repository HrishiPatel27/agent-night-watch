import type { BudgetState, Policy, SessionRecord } from '@nightwatch-agent/shared';
import type { NightwatchStore } from './store.js';

export function deadlineFor(session: SessionRecord, policy: Policy): string {
  const start = Date.parse(session.started_at);
  return new Date(start + policy.limits.wall_time_minutes * 60_000).toISOString();
}

export function computeBudget(store: NightwatchStore, session: SessionRecord, policy: Policy, inputDigest?: string): BudgetState {
  const spend = session.cost_usd ?? undefined;
  return {
    actionsUsed: store.countActions(session.id),
    actionsLimit: policy.limits.actions,
    consecutiveDenials: store.consecutiveDenials(session.id),
    consecutiveDenialsLimit: policy.limits.consecutive_denials,
    deadline: deadlineFor(session, policy),
    spendUsd: spend,
    spendLimitUsd: policy.limits.budget_usd,
    repeatedCommandCount: inputDigest ? store.repeatedCommandCount(session.id, inputDigest) : undefined,
    repeatedCommandLimit: policy.limits.repeated_command,
    stopRequested: session.status === 'stopping' ? session.stop_reason ?? 'stop requested' : undefined,
  };
}

/** Runner-side stop conditions (checked by the watchdog, not per tool call). */
export function stopReason(store: NightwatchStore, session: SessionRecord, policy: Policy, now = Date.now()): string | null {
  if (session.status === 'stopping') return session.stop_reason ?? 'stop requested';
  if (now >= Date.parse(deadlineFor(session, policy))) return `wall-time limit of ${policy.limits.wall_time_minutes} minutes reached`;
  const actions = store.countActions(session.id);
  if (policy.limits.actions > 0 && actions >= policy.limits.actions) return `action limit of ${policy.limits.actions} reached`;
  const denials = store.consecutiveDenials(session.id);
  if (policy.limits.consecutive_denials > 0 && denials >= policy.limits.consecutive_denials) return `${denials} consecutive denials`;
  if (policy.limits.budget_usd && session.cost_usd != null && session.cost_usd >= policy.limits.budget_usd) return `estimated spend $${session.cost_usd.toFixed(2)} reached the $${policy.limits.budget_usd.toFixed(2)} ceiling`;
  if (policy.limits.idle_minutes > 0 && session.last_activity_at) {
    const idleMs = now - Date.parse(session.last_activity_at);
    if (idleMs > policy.limits.idle_minutes * 60_000) return `no activity for ${policy.limits.idle_minutes} minutes`;
  }
  if (policy.limits.failed_test_runs > 0 && store.countFailedTestRuns(session.id) >= policy.limits.failed_test_runs) return `${policy.limits.failed_test_runs} failed test runs`;
  return null;
}
