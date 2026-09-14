import fs from 'node:fs';
import YAML from 'yaml';
import { MODES, POLICY_SCHEMA_VERSION, type Mode, type Policy } from '@nightwatch-agent/shared';
import { DEFAULT_ALLOW, DEFAULT_DENY, DEFAULT_LIMITS } from './presets.js';

export class PolicyError extends Error {
  constructor(message: string, public readonly problems: string[] = []) {
    super(message);
    this.name = 'PolicyError';
  }
}

export interface LoadedPolicy {
  policy: Policy;
  yaml: string;
  warnings: string[];
}

export function loadPolicyFile(file: string): LoadedPolicy {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new PolicyError(`cannot read policy file ${file}: ${(err as Error).message}`);
  }
  return parsePolicy(text);
}

export function parsePolicy(text: string): LoadedPolicy {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new PolicyError(`policy is not valid YAML: ${(err as Error).message}`);
  }
  const { policy, problems, warnings } = normalizePolicy(doc);
  if (problems.length) throw new PolicyError(`policy is invalid:\n  - ${problems.join('\n  - ')}`, problems);
  return { policy, yaml: text, warnings };
}

export function normalizePolicy(doc: unknown): { policy: Policy; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const o = (doc ?? {}) as Record<string, unknown>;
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) problems.push('top level must be a mapping');

  const version = o.version ?? POLICY_SCHEMA_VERSION;
  if (version !== POLICY_SCHEMA_VERSION) problems.push(`unsupported policy version ${String(version)} (expected ${POLICY_SCHEMA_VERSION})`);

  const mode = (o.mode ?? 'quarantine') as Mode;
  if (!MODES.includes(mode)) problems.push(`mode must be one of ${MODES.join(', ')}`);

  const limitsIn = asRecord(o.limits, 'limits', problems);
  const limits: Policy['limits'] = {
    wall_time_minutes: num(limitsIn.wall_time_minutes, DEFAULT_LIMITS.wall_time_minutes, 'limits.wall_time_minutes', problems, 1),
    actions: num(limitsIn.actions, DEFAULT_LIMITS.actions, 'limits.actions', problems, 0),
    consecutive_denials: num(limitsIn.consecutive_denials, DEFAULT_LIMITS.consecutive_denials, 'limits.consecutive_denials', problems, 0),
    budget_usd: limitsIn.budget_usd == null ? undefined : num(limitsIn.budget_usd, 0, 'limits.budget_usd', problems, 0),
    repeated_command: num(limitsIn.repeated_command, DEFAULT_LIMITS.repeated_command, 'limits.repeated_command', problems, 0),
    idle_minutes: num(limitsIn.idle_minutes, DEFAULT_LIMITS.idle_minutes, 'limits.idle_minutes', problems, 0),
    failed_test_runs: num(limitsIn.failed_test_runs, DEFAULT_LIMITS.failed_test_runs, 'limits.failed_test_runs', problems, 0),
  };

  const allowIn = asRecord(o.allow, 'allow', problems);
  const allow: Policy['allow'] = {
    commands: strList(allowIn.commands, 'allow.commands', problems),
    paths: strList(allowIn.paths ?? DEFAULT_ALLOW.paths, 'allow.paths', problems),
    read_paths: strList(allowIn.read_paths, 'allow.read_paths', problems),
    domains: strList(allowIn.domains ?? DEFAULT_ALLOW.domains, 'allow.domains', problems),
    mcp_tools: strList(allowIn.mcp_tools, 'allow.mcp_tools', problems),
    tools: strList(allowIn.tools, 'allow.tools', problems),
    builtin_safe_commands: bool(allowIn.builtin_safe_commands, DEFAULT_ALLOW.builtin_safe_commands, 'allow.builtin_safe_commands', problems),
    web_search: bool(allowIn.web_search, DEFAULT_ALLOW.web_search, 'allow.web_search', problems),
  };

  const denyIn = asRecord(o.deny, 'deny', problems);
  const deny: Policy['deny'] = {
    paths: strList(denyIn.paths ?? DEFAULT_DENY.paths, 'deny.paths', problems),
    commands: strList(denyIn.commands ?? DEFAULT_DENY.commands, 'deny.commands', problems),
    detached_processes: bool(denyIn.detached_processes, DEFAULT_DENY.detached_processes, 'deny.detached_processes', problems),
    unknown_mcp_tools: bool(denyIn.unknown_mcp_tools, DEFAULT_DENY.unknown_mcp_tools, 'deny.unknown_mcp_tools', problems),
  };

  const unknown = (o.unknown_commands ?? 'defer') as Policy['unknown_commands'];
  if (unknown !== 'allow' && unknown !== 'defer') problems.push('unknown_commands must be "allow" or "defer"');
  if (unknown === 'allow' && mode !== 'observe') warnings.push('unknown_commands: allow lets any command that is not explicitly denied run; hard-deny rules still apply');

  const redact = strList(o.redact_patterns, 'redact_patterns', problems);
  for (const r of redact) {
    try {
      new RegExp(r);
    } catch {
      problems.push(`redact_patterns entry is not a valid regular expression: ${r}`);
    }
  }
  if (!allow.domains.length) warnings.push('allow.domains is empty: every network destination will be denied');
  if (limits.consecutive_denials === 0) warnings.push('limits.consecutive_denials is 0: a looping agent will not be stopped by denials');

  const policy: Policy = {
    version: 1,
    name: typeof o.name === 'string' && o.name ? o.name : 'custom',
    mode,
    limits,
    allow,
    deny,
    unknown_commands: unknown,
    test_command: typeof o.test_command === 'string' && o.test_command ? o.test_command : undefined,
    redact_patterns: redact,
  };
  return { policy, problems, warnings };
}

export function policyToYaml(policy: Policy, header = true): string {
  const doc: Record<string, unknown> = {
    version: policy.version,
    name: policy.name,
    mode: policy.mode,
    limits: stripUndefined({ ...policy.limits }),
    allow: policy.allow,
    deny: policy.deny,
    unknown_commands: policy.unknown_commands,
  };
  if (policy.test_command) doc.test_command = policy.test_command;
  if (policy.redact_patterns.length) doc.redact_patterns = policy.redact_patterns;
  const body = YAML.stringify(doc, { lineWidth: 100 });
  if (!header) return body;
  return `# Nightwatch policy — deterministic rules that decide what an unattended agent may do.
# Docs: docs/policy.md. Precedence: hard deny → budget stop → explicit allow → unknown (defer).
# Variables: \${RUN_WORKTREE}, \${PROJECT_ROOT}, \${HOME}, ~
${body}`;
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function asRecord(v: unknown, name: string, problems: string[]): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) {
    problems.push(`${name} must be a mapping`);
    return {};
  }
  return v as Record<string, unknown>;
}

function num(v: unknown, dflt: number, name: string, problems: string[], min: number): number {
  if (v == null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
    problems.push(`${name} must be a number ≥ ${min}`);
    return dflt;
  }
  return v;
}

function bool(v: unknown, dflt: boolean, name: string, problems: string[]): boolean {
  if (v == null) return dflt;
  if (typeof v !== 'boolean') {
    problems.push(`${name} must be true or false`);
    return dflt;
  }
  return v;
}

function strList(v: unknown, name: string, problems: string[]): string[] {
  if (v == null) return [];
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    problems.push(`${name} must be a list of strings`);
    return [];
  }
  return v as string[];
}
