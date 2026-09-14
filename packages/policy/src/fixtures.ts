import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Decision, Policy, PolicyContext, ReasonCode } from '@nightwatch-agent/shared';
import { evaluate } from './engine.js';

export interface FixtureCase {
  /** Shell command (tool defaults to Bash) … */
  command?: string;
  /** … or an explicit tool call. */
  tool?: string;
  input?: Record<string, unknown>;
  expect: Decision;
  reason?: ReasonCode;
  note?: string;
  /** Override policy fields for this case (e.g. unknown_commands: allow). */
  policy?: Record<string, unknown>;
  cwd?: string;
}

export interface FixtureResult {
  file: string;
  index: number;
  case: FixtureCase;
  pass: boolean;
  got: { decision: Decision; reasonCode: ReasonCode; reason: string; rule?: string };
}

export function loadFixtureFiles(dir: string): { file: string; cases: FixtureCase[] }[] {
  const out: { file: string; cases: FixtureCase[] }[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const file = path.join(dir, name);
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    const cases = Array.isArray(doc) ? doc : Array.isArray(doc?.cases) ? doc.cases : [];
    out.push({ file, cases });
  }
  return out;
}

/**
 * Run every fixture against the given base policy/context. A fixture passes if
 * the decision matches and, when a reason code is given, the code matches too.
 */
export function runFixtures(dir: string, base: PolicyContext): FixtureResult[] {
  const results: FixtureResult[] = [];
  for (const { file, cases } of loadFixtureFiles(dir)) {
    cases.forEach((c, index) => {
      const policy: Policy = c.policy ? deepMerge(base.policy, c.policy) : base.policy;
      const ctx: PolicyContext = { ...base, policy, mode: policy.mode };
      const vars: Record<string, string> = { PROJECT_ROOT: base.projectRoot, RUN_WORKTREE: base.runWorktree, HOME: base.homeDir ?? '' };
      const subst = (v: unknown): unknown => (typeof v === 'string' ? v.replace(/\$\{(PROJECT_ROOT|RUN_WORKTREE|HOME)\}/g, (_, k) => vars[k]) : v);
      const tool = c.tool ?? 'Bash';
      const rawInput = c.input ?? (c.command != null ? { command: c.command } : {});
      const input = Object.fromEntries(Object.entries(rawInput).map(([k, v]) => [k, subst(v)]));
      const cwd = c.cwd ? path.resolve(base.runWorktree, c.cwd) : base.runWorktree;
      const d = evaluate({ tool, input, cwd }, ctx);
      const pass = d.decision === c.expect && (!c.reason || d.reasonCode === c.reason);
      results.push({ file, index, case: c, pass, got: { decision: d.decision, reasonCode: d.reasonCode, reason: d.reason, rule: d.rule } });
    });
  }
  return results;
}

function deepMerge<T>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v as Record<string, unknown>);
    } else out[k] = v;
  }
  return out as T;
}
