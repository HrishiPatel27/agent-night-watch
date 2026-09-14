import fs from 'node:fs';
import path from 'node:path';
import { computeBudget, NightwatchStore } from '@nightwatch-agent/daemon';
import { loadPolicyFile, parsePolicy } from '@nightwatch-agent/policy';
import { findProjectRoot, nightwatchPaths, nowIso, type Policy, type PolicyContext, type SessionRecord } from '@nightwatch-agent/shared';

export interface ResolvedSession {
  store: NightwatchStore;
  session: SessionRecord;
  policy: Policy;
  /** True when the session was found through the runner's environment variables. */
  pinned: boolean;
}

export type SessionLookup = { kind: 'session'; value: ResolvedSession } | { kind: 'none' } | { kind: 'deny'; reason: string };

/**
 * Find the guarded session this hook invocation belongs to.
 *  1. NIGHTWATCH_SESSION_ID + NIGHTWATCH_DB from the runner (fail closed if missing/not running).
 *  2. Otherwise the project's .nightwatch database: an active session covering cwd, or an
 *     attended "guard" session when a policy file exists (interactive use after `nightwatch init --hooks`).
 *  3. Otherwise: not supervised.
 */
export function lookupSession(cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): SessionLookup {
  const pinnedId = env.NIGHTWATCH_SESSION_ID;
  const pinnedDb = env.NIGHTWATCH_DB;
  if (pinnedId && pinnedDb) {
    if (!fs.existsSync(pinnedDb)) return { kind: 'deny', reason: `session database ${pinnedDb} is missing` };
    const store = new NightwatchStore(pinnedDb);
    const session = store.getSession(pinnedId);
    if (!session) {
      store.close();
      return { kind: 'deny', reason: `session ${pinnedId} not found` };
    }
    if (session.status !== 'running') {
      store.close();
      return { kind: 'deny', reason: `session ${pinnedId} is ${session.status}` };
    }
    return { kind: 'session', value: { store, session, policy: parsePolicy(session.policy_yaml).policy, pinned: true } };
  }
  const start = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  const root = findProjectRoot(start);
  if (!root) return { kind: 'none' };
  const paths = nightwatchPaths(root);
  const hasDb = fs.existsSync(paths.db);
  const hasPolicy = fs.existsSync(paths.policy);
  if (!hasDb && !hasPolicy) return { kind: 'none' };
  const store = new NightwatchStore(paths.db);
  const active = store.activeSessions().find((s) => s.status === 'running' && (isInside(s.worktree, start) || isInside(s.project_root, start)));
  if (active && active.unattended) {
    return { kind: 'session', value: { store, session: active, policy: parsePolicy(active.policy_yaml).policy, pinned: false } };
  }
  if (!hasPolicy) {
    store.close();
    return { kind: 'none' };
  }
  // Attended guard session for interactive agents (one per day).
  const loaded = loadPolicyFile(paths.policy);
  const policy: Policy = { ...loaded.policy, mode: loaded.policy.mode === 'quarantine' ? 'guard' : loaded.policy.mode };
  const id = `guard-${nowIso().slice(0, 10)}`;
  let session = store.getSession(id);
  if (!session) {
    session = store.createSession({
      id,
      project_root: root,
      worktree: root,
      branch: null,
      base_ref: null,
      mode: policy.mode,
      agent: env.NIGHTWATCH_ADAPTER ?? 'interactive',
      task: 'interactive guard session',
      policy_name: policy.name,
      policy_version: String(policy.version),
      policy_yaml: loaded.yaml,
      unattended: false,
      limits: { ...policy.limits },
      status: 'running',
    });
  } else if (session.status !== 'running') {
    store.setStatus(id, 'running');
    session = store.getSession(id)!;
  }
  return { kind: 'session', value: { store, session, policy, pinned: false } };
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function contextFor(r: ResolvedSession, inputDigest?: string): PolicyContext {
  return {
    policy: r.policy,
    mode: r.session.mode,
    projectRoot: r.session.project_root,
    runWorktree: r.session.worktree,
    unattended: !!r.session.unattended,
    budget: computeBudget(r.store, r.session, r.policy, inputDigest),
  };
}
