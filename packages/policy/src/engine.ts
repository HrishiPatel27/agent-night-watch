import os from 'node:os';
import path from 'node:path';
import {
  canonicalizePath,
  isPathInside,
  PathResolutionError,
  REASON_TEXT,
  redactText,
  summarizeToolInput,
  tmpDirs,
  type BudgetState,
  type Decision,
  type NormalizedCall,
  type PolicyContext,
  type PolicyDecision,
  type ReasonCode,
  type ToolCallRequest,
} from '@nightwatch-agent/shared';
import { commandName, hasFlag, parseCommand, positionals, segmentText, type SimpleCommand } from './command.js';
import { compilePathGlobs, expandRoots, matchDomain, matchesAnyCommand, type PathMatcher } from './match.js';
import { hostFromRemoteSpec, hostFromUrl, hostsFromText, isLoopbackHost } from './hosts.js';
import * as C from './catalog.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Hit {
  code: ReasonCode;
  rule: string;
  reason: string;
  matched?: string;
  /** User-supplied pattern hits rank below the built-in classification so reports show the specific reason. */
  weak?: boolean;
}

/** Lower is stronger. Hard denies come first, budget second, then soft classes. */
const PRECEDENCE: Record<string, number> = {
  SUPERVISOR_TAMPER: 0,
  SECRET_PATH: 1,
  DESTRUCTIVE_COMMAND: 2,
  PROD_RISK: 3,
  DETACHED_PROCESS: 4,
  OUTSIDE_WORKTREE: 5,
  PATH_UNRESOLVED: 6,
  BUDGET_EXCEEDED: 10,
  NETWORK_NOT_ALLOWED: 20,
  UNKNOWN_TOOL: 30,
  UNKNOWN_COMMAND: 31,
  MALFORMED_INPUT: 32,
};

const HARD_CODES = new Set<ReasonCode>(['SUPERVISOR_TAMPER', 'SECRET_PATH', 'DESTRUCTIVE_COMMAND', 'PROD_RISK', 'DETACHED_PROCESS', 'OUTSIDE_WORKTREE', 'PATH_UNRESOLVED']);

interface Env {
  ctx: PolicyContext;
  platform: NodeJS.Platform;
  home: string;
  writeRoots: string[];
  readRoots: string[];
  secretMatch: PathMatcher;
  /** Supervisor configuration: the project's .nightwatch directory (outside the run worktree) and agent hook files. */
  protectedMatch: PathMatcher;
  denyCommands: string[];
  allowCommands: string[];
  domains: string[];
  redact: (s: string) => string;
}

function buildEnv(ctx: PolicyContext): Env {
  const platform = ctx.platform ?? process.platform;
  const home = ctx.homeDir ?? os.homedir();
  const vars = { RUN_WORKTREE: ctx.runWorktree, PROJECT_ROOT: ctx.projectRoot, HOME: home };
  const scratch = ctx.scratchDirs ?? tmpDirs();
  const writeRoots = uniq([ctx.runWorktree, ...expandRoots(ctx.policy.allow.paths, vars), ...scratch]);
  const readRoots = uniq([...writeRoots, ctx.projectRoot, ...expandRoots(ctx.policy.allow.read_paths, vars)]);
  const secretMatch = compilePathGlobs([...C.DEFAULT_SECRET_PATH_GLOBS, ...ctx.policy.deny.paths], vars, platform);
  const protectedGlobs = compilePathGlobs(C.PROTECTED_PATH_GLOBS, vars, platform);
  const nightwatchDir = path.join(ctx.projectRoot, '.nightwatch');
  const protectedMatch: PathMatcher = (abs) => {
    if (isPathInside(nightwatchDir, abs, platform) && !isPathInside(ctx.runWorktree, abs, platform)) return '.nightwatch/**';
    return protectedGlobs(abs);
  };
  const extra = ctx.policy.redact_patterns ?? [];
  return {
    ctx,
    platform,
    home,
    writeRoots,
    readRoots,
    secretMatch,
    protectedMatch,
    denyCommands: ctx.policy.deny.commands ?? [],
    allowCommands: ctx.policy.allow.commands ?? [],
    domains: ctx.policy.allow.domains ?? [],
    redact: (s: string) => redactText(s, { extraPatterns: extra }),
  };
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs.filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate one tool call. Never throws: any internal failure becomes a deny
 * with MALFORMED_INPUT so the hook fails closed.
 */
export function evaluate(req: ToolCallRequest, ctx: PolicyContext): PolicyDecision {
  const normalized: NormalizedCall = {
    tool: req.tool,
    summary: '',
    paths: [],
    commands: [],
    hosts: [],
    flags: {},
  };
  try {
    normalized.summary = summarizeToolInput(req.tool, req.input, { extraPatterns: ctx.policy.redact_patterns });
    const env = buildEnv(ctx);
    const result = evaluateInner(req, env, normalized);
    if (ctx.mode === 'observe' && result.decision !== 'allow') {
      return {
        ...result,
        decision: 'allow',
        reasonCode: 'OBSERVE_ONLY',
        reason: `observe mode: would ${result.decision} (${result.reasonCode}: ${result.reason})`,
        shadow: result,
      } as PolicyDecision & { shadow: PolicyDecision };
    }
    return result;
  } catch (err) {
    return {
      decision: 'deny',
      reasonCode: 'MALFORMED_INPUT',
      reason: `${REASON_TEXT.MALFORMED_INPUT}: ${(err as Error).message}`,
      rule: 'engine.exception',
      normalized,
    };
  }
}

function evaluateInner(req: ToolCallRequest, env: Env, normalized: NormalizedCall): PolicyDecision {
  const { ctx } = env;
  const tool = req.tool;
  const input = req.input ?? {};
  const hits: Hit[] = [];
  let unknown: Hit | null = null;
  let explicit: string | null = null;
  let builtin: string | null = null;

  if (tool === 'Bash' || tool === 'PowerShell' || (tool === 'Monitor' && typeof input.command === 'string')) {
    const command = typeof input.command === 'string' ? input.command : '';
    if (!command.trim()) {
      hits.push({ code: 'MALFORMED_INPUT', rule: 'bash.empty', reason: 'empty command' });
    } else {
      const r = evaluateShell(command, input, req.cwd, env, normalized);
      hits.push(...r.hits);
      unknown = r.unknown;
      explicit = r.explicit;
      builtin = r.builtin;
    }
  } else if (C.WRITE_TOOLS.has(tool)) {
    const p = pathFromInput(input);
    if (!p) hits.push({ code: 'MALFORMED_INPUT', rule: 'write.nopath', reason: 'write tool call without a path' });
    else {
      const chk = checkPath(p, req.cwd, env, 'write', normalized);
      if (chk) hits.push(chk);
      else builtin = 'in-worktree write';
    }
    if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
      const text = String(input.content ?? input.file_text ?? input.new_string ?? '');
      const cs = connectionStringHit(text);
      if (cs) hits.push(cs);
    }
  } else if (C.READ_TOOLS.has(tool)) {
    const p = pathFromInput(input) ?? (typeof input.path === 'string' ? input.path : null);
    if (!p) {
      // Glob/Grep without an explicit path search the cwd.
      const chk = checkPath(req.cwd, req.cwd, env, 'read', normalized);
      if (chk) hits.push(chk);
      else builtin = 'read in cwd';
    } else {
      const chk = checkPath(p, req.cwd, env, 'read', normalized);
      if (chk) hits.push(chk);
      else builtin = 'in-worktree read';
    }
  } else if (tool === 'WebFetch') {
    const url = typeof input.url === 'string' ? input.url : '';
    const host = hostFromUrl(url);
    normalized.flags.network = true;
    if (host) normalized.hosts.push(host);
    if (!host) hits.push({ code: 'MALFORMED_INPUT', rule: 'webfetch.url', reason: 'WebFetch without a valid URL' });
    else if (!matchDomain(env.domains, host)) hits.push({ code: 'NETWORK_NOT_ALLOWED', rule: 'webfetch.domain', reason: `${host} is not in allow.domains`, matched: host });
    else builtin = 'allowed domain';
  } else if (tool === 'WebSearch') {
    normalized.flags.network = true;
    if (!ctx.policy.allow.web_search) hits.push({ code: 'NETWORK_NOT_ALLOWED', rule: 'websearch.disabled', reason: 'WebSearch is disabled by policy (allow.web_search)' });
    else builtin = 'web search enabled';
  } else if (tool.startsWith('mcp__')) {
    const m = matchesAnyCommand(ctx.policy.allow.mcp_tools ?? [], tool);
    if (m) explicit = m;
    else if (ctx.policy.deny.unknown_mcp_tools) unknown = { code: 'UNKNOWN_TOOL', rule: 'mcp.unknown', reason: `MCP tool ${tool} is not in allow.mcp_tools` };
    else builtin = 'mcp tools allowed';
    const text = JSON.stringify(input);
    const cs = connectionStringHit(text);
    if (cs) hits.push(cs);
    for (const h of hostsFromText(text)) normalized.hosts.push(h);
  } else if (C.EXTERNAL_TOOLS.has(tool)) {
    const m = matchesAnyCommand(ctx.policy.allow.tools ?? [], tool);
    if (m) explicit = m;
    else hits.push({ code: 'PROD_RISK', rule: 'tool.external', reason: `${tool} publishes, schedules or messages outside the run` });
  } else if (C.HARMLESS_TOOLS.has(tool)) {
    builtin = 'harmless tool';
  } else {
    const m = matchesAnyCommand(ctx.policy.allow.tools ?? [], tool);
    if (m) explicit = m;
    else unknown = { code: 'UNKNOWN_TOOL', rule: 'tool.unknown', reason: `tool ${tool} is not modelled by Nightwatch and not in allow.tools` };
  }

  // Precedence 1: hard denies.
  const hard = strongest(hits.filter((h) => HARD_CODES.has(h.code) || h.code === 'MALFORMED_INPUT'));
  if (hard) return deny(hard, normalized, env);

  // Precedence 2: budget.
  const budgetHit = checkBudget(ctx.budget);
  if (budgetHit) return deny(budgetHit, normalized, env);

  // Precedence 3: explicit allow beats soft classes (network, unknown).
  if (explicit) {
    return allow('EXPLICIT_ALLOW', `matches allow rule "${explicit}"`, normalized, `allow:${explicit}`);
  }
  const soft = strongest(hits);
  if (soft) return deny(soft, normalized, env);

  // Precedence 4: unknown → defer. Unattended runs cannot wait, so defer becomes a deny that is
  // recorded for morning review; attended (guard) sessions surface it as a question.
  if (unknown) {
    if (unknown.code === 'UNKNOWN_COMMAND' && ctx.policy.unknown_commands === 'allow') {
      return allow('BUILTIN_SAFE', `unknown command allowed by policy (unknown_commands: allow); ${unknown.reason}`, normalized, 'unknown_commands.allow');
    }
    const text = `${REASON_TEXT[unknown.code]}. ${unknown.reason}`;
    return {
      decision: ctx.unattended ? 'deny' : 'defer',
      reasonCode: unknown.code,
      reason: env.redact(ctx.unattended ? `Deferred for morning review (blocked in unattended mode). ${text}` : text),
      rule: unknown.rule,
      matched: unknown.matched ? env.redact(unknown.matched) : undefined,
      normalized,
    };
  }
  return allow(builtin === 'in-worktree write' || builtin === 'in-worktree read' || builtin === 'read in cwd' ? 'IN_WORKTREE' : 'BUILTIN_SAFE', builtin ?? 'no rule matched', normalized, `builtin:${builtin ?? 'none'}`);
}

function deny(hit: Hit, normalized: NormalizedCall, env: Env): PolicyDecision {
  return {
    decision: 'deny',
    reasonCode: hit.code,
    reason: env.redact(`${REASON_TEXT[hit.code]}. ${hit.reason}`),
    rule: hit.rule,
    matched: hit.matched ? env.redact(hit.matched) : undefined,
    normalized,
  };
}

function allow(code: ReasonCode, reason: string, normalized: NormalizedCall, rule: string): PolicyDecision {
  return { decision: 'allow', reasonCode: code, reason, rule, normalized };
}

function rank(h: Hit): number {
  return h.weak ? 9 : (PRECEDENCE[h.code] ?? 99);
}

function strongest(hits: Hit[]): Hit | null {
  let best: Hit | null = null;
  for (const h of hits) {
    if (!best || rank(h) < rank(best)) best = h;
  }
  return best;
}

export function checkBudget(b: BudgetState | undefined): Hit | null {
  if (!b) return null;
  if (b.stopRequested) return { code: 'BUDGET_EXCEEDED', rule: 'budget.stop', reason: `stop requested: ${b.stopRequested}` };
  if (b.actionsLimit > 0 && b.actionsUsed >= b.actionsLimit) {
    return { code: 'BUDGET_EXCEEDED', rule: 'budget.actions', reason: `action limit reached (${b.actionsUsed}/${b.actionsLimit})` };
  }
  if (b.consecutiveDenialsLimit > 0 && b.consecutiveDenials >= b.consecutiveDenialsLimit) {
    return { code: 'BUDGET_EXCEEDED', rule: 'budget.denials', reason: `${b.consecutiveDenials} consecutive denials (limit ${b.consecutiveDenialsLimit})` };
  }
  if (b.deadline) {
    const now = b.now ? Date.parse(b.now) : Date.now();
    if (now >= Date.parse(b.deadline)) return { code: 'BUDGET_EXCEEDED', rule: 'budget.wall_time', reason: `wall-time limit reached at ${b.deadline}` };
  }
  if (b.spendLimitUsd != null && b.spendUsd != null && b.spendLimitUsd > 0 && b.spendUsd >= b.spendLimitUsd) {
    return { code: 'BUDGET_EXCEEDED', rule: 'budget.spend', reason: `estimated spend $${b.spendUsd.toFixed(2)} reached the $${b.spendLimitUsd.toFixed(2)} ceiling` };
  }
  if (b.repeatedCommandLimit && b.repeatedCommandCount != null && b.repeatedCommandCount >= b.repeatedCommandLimit) {
    return { code: 'BUDGET_EXCEEDED', rule: 'budget.loop', reason: `the same command was attempted ${b.repeatedCommandCount} times in a row` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function pathFromInput(input: Record<string, unknown>): string | null {
  for (const k of ['file_path', 'path', 'notebook_path', 'filePath']) {
    const v = input[k];
    if (typeof v === 'string' && v.length) return v;
  }
  return null;
}

type Access = 'read' | 'write' | 'cd';

function checkPath(raw: string, cwd: string, env: Env, access: Access, normalized: NormalizedCall): Hit | null {
  let abs: string;
  let viaSymlink = false;
  try {
    const c = canonicalizePath(raw, cwd, env.home);
    abs = c.path;
    viaSymlink = c.viaSymlink;
  } catch (err) {
    return { code: 'PATH_UNRESOLVED', rule: 'path.unresolved', reason: (err as PathResolutionError).message, matched: raw };
  }
  normalized.paths.push(abs);
  const protectedHit = env.protectedMatch(abs);
  if (protectedHit && access !== 'cd') {
    return { code: 'SUPERVISOR_TAMPER', rule: 'path.protected', reason: `${access} of supervisor configuration ${shortPath(abs, env)} (${protectedHit})`, matched: raw };
  }
  const base = path.basename(abs);
  const secretHit = env.secretMatch(abs) ?? env.secretMatch(raw.replace(/^~/, env.home));
  if (secretHit && !C.SECRET_EXCEPTION_RE.test(base)) {
    return { code: 'SECRET_PATH', rule: 'path.secret', reason: `${shortPath(abs, env)} matches deny.paths pattern "${secretHit}"`, matched: raw };
  }
  const roots = access === 'write' ? env.writeRoots : env.readRoots;
  if (!roots.some((r) => isPathInside(r, abs, env.platform))) {
    const where = access === 'write' ? 'writable roots' : 'readable roots';
    return {
      code: 'OUTSIDE_WORKTREE',
      rule: `path.${access}.outside`,
      reason: `${access === 'cd' ? 'cd to' : access + ' of'} ${shortPath(abs, env)} is outside the ${where}${viaSymlink ? ' (resolved through a symlink)' : ''}`,
      matched: raw,
    };
  }
  if (access === 'write') normalized.flags.write = true;
  return null;
}

function shortPath(abs: string, env: Env): string {
  const rel = path.relative(env.ctx.runWorktree, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `./${rel.replace(/\\/g, '/')}`;
  return abs;
}

// ---------------------------------------------------------------------------
// Shell commands
// ---------------------------------------------------------------------------

interface ShellResult {
  hits: Hit[];
  unknown: Hit | null;
  explicit: string | null;
  builtin: string | null;
}

const DEV_DISK_RE = /^\/dev\/(sd|hd|nvme|disk|rdisk|xvd|vd|mmcblk|loop|dm-|md|mapper)/i;
const DEV_IGNORE_RE = /^\/dev\/(null|stdout|stderr|stdin|tty|fd\/\d+|zero|urandom|random)$/i;
const FORK_BOMB_RE = /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&/;

function evaluateShell(command: string, input: Record<string, unknown>, cwd: string, env: Env, normalized: NormalizedCall): ShellResult {
  const hits: Hit[] = [];
  const { ctx } = env;
  const policy = ctx.policy;
  normalized.summary = env.redact(command.length > 400 ? `${command.slice(0, 399)}…` : command);

  if (input.run_in_background === true && policy.deny.detached_processes) {
    hits.push({ code: 'DETACHED_PROCESS', rule: 'bash.run_in_background', reason: 'run_in_background requested' });
  }

  // Raw-text rules that survive tokenisation tricks.
  if (FORK_BOMB_RE.test(command)) hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'raw.forkbomb', reason: 'fork bomb pattern' });
  const cs = connectionStringHit(command);
  if (cs) hits.push(cs);
  for (const re of C.WINDOWS_DESTRUCTIVE_PATTERNS) {
    if (re.test(command)) {
      hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'raw.windows', reason: `matches Windows destructive pattern ${re.source.slice(0, 40)}`, matched: command.match(re)?.[0] });
      break;
    }
  }
  const secretEnv = C.SECRET_ENV_RE.exec(command);
  if (secretEnv) hits.push({ code: 'SECRET_PATH', rule: 'raw.secret_env', reason: `expands secret environment variable ${secretEnv[1]}`, matched: secretEnv[0] });
  if (/\/dev\/(tcp|udp)\//i.test(command)) hits.push({ code: 'NETWORK_NOT_ALLOWED', rule: 'raw.devtcp', reason: 'bash /dev/tcp network redirection' });
  const denyRaw = matchesAnyCommand(env.denyCommands, command);
  if (denyRaw) hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'policy.deny.commands', reason: `matches deny.commands pattern "${denyRaw}"`, matched: command, weak: true });

  const parsed = parseCommand(command);
  let unknown: Hit | null = null;
  const explicitMatches: string[] = [];
  let allSegmentsCovered = parsed.segments.length > 0;
  let effectiveCwd = cwd;

  if (!parsed.complete) {
    unknown = { code: 'UNKNOWN_COMMAND', rule: 'shell.unparsed', reason: `shell construct not understood (${parsed.notes.join('; ') || 'unknown'})` };
    allSegmentsCovered = false;
  }

  for (const seg of parsed.segments) {
    if (!seg.argv.length && !seg.redirects.length) continue;
    const text = segmentText(seg);
    if (text) normalized.commands.push(env.redact(text));
    const head = commandName(seg.argv[0] ?? '');

    // deny.commands per segment (after unwrapping wrappers)
    const denySeg = matchesAnyCommand(env.denyCommands, text);
    if (denySeg) hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'policy.deny.commands', reason: `matches deny.commands pattern "${denySeg}"`, matched: text, weak: true });

    // Environment tampering via assignments
    for (const a of seg.assignments) {
      const name = a.split('=')[0];
      if (/^(NIGHTWATCH_|CLAUDE_CONFIG|CLAUDE_CODE_|CURSOR_|GEMINI_|CODEX_)/.test(name)) {
        hits.push({ code: 'SUPERVISOR_TAMPER', rule: 'env.assign', reason: `sets supervisor variable ${name}`, matched: a });
      }
      if (name === 'PATH' && process.env.NIGHTWATCH_SHIM_GUARD) {
        hits.push({ code: 'SUPERVISOR_TAMPER', rule: 'env.path', reason: 'modifies PATH while the shim guard is active', matched: a });
      }
    }

    if (seg.privileged) hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'shell.privilege', reason: `privilege escalation via ${seg.wrappers.find((w) => C.PRIVILEGE_HEADS.has(w)) ?? 'sudo'}`, matched: text });
    if ((seg.background || seg.detached) && policy.deny.detached_processes) {
      hits.push({ code: 'DETACHED_PROCESS', rule: seg.background ? 'shell.background' : 'shell.detach_wrapper', reason: seg.background ? 'command ends with & (background job)' : `uses ${seg.wrappers.join(' ')}`, matched: text });
      normalized.flags.background = true;
    }

    // Redirections
    for (const r of seg.redirects) {
      if (!r.target || r.target.startsWith('&')) continue;
      if (DEV_IGNORE_RE.test(r.target) || /^\/dev\/(tcp|udp)\//i.test(r.target)) continue;
      if (DEV_DISK_RE.test(r.target)) {
        hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'redirect.device', reason: `writes to block device ${r.target}`, matched: r.target });
        continue;
      }
      const isWrite = !r.op.startsWith('<') && !/^\d*<$/.test(r.op);
      const chk = checkPath(r.target, effectiveCwd, env, isWrite ? 'write' : 'read', normalized);
      if (chk) hits.push(chk);
    }

    if (!head) continue;

    const segHits: Hit[] = [];
    const cls = classifySegment(seg, head, effectiveCwd, env, normalized, segHits);
    hits.push(...segHits);
    if (cls.cd) effectiveCwd = cls.cd;

    // Explicit allow per segment
    const exp = matchesAnyCommand(env.allowCommands, text) ?? matchesAnyCommand(env.allowCommands, seg.raw);
    if (exp) {
      explicitMatches.push(exp);
      continue;
    }
    if (cls.kind === 'safe') continue;
    if (cls.kind === 'network') {
      // network segments not explicitly allowed
      hits.push(cls.hit!);
      continue;
    }
    // unknown
    allSegmentsCovered = false;
    if (!unknown) unknown = cls.hit ?? { code: 'UNKNOWN_COMMAND', rule: 'shell.unknown', reason: `"${text}" is not a recognised safe command and is not in allow.commands`, matched: text };
  }

  const explicit = allSegmentsCovered && explicitMatches.length ? explicitMatches[0] : null;
  const builtin = allSegmentsCovered && !explicit ? 'safe shell command' : null;
  return { hits, unknown: allSegmentsCovered ? null : unknown ?? { code: 'UNKNOWN_COMMAND', rule: 'shell.unknown', reason: 'command not recognised' }, explicit, builtin };
}

interface Classification {
  kind: 'safe' | 'network' | 'unknown';
  hit?: Hit;
  cd?: string;
}

const VERSION_ARGS = new Set(['--version', '-version', '-v', '-V', 'version', '--help', '-h', 'help', '-?', '/?']);

function classifySegment(seg: SimpleCommand, head: string, cwd: string, env: Env, normalized: NormalizedCall, hits: Hit[]): Classification {
  const argv = seg.argv;
  const text = segmentText(seg);
  const pos = positionals(argv);
  const { ctx } = env;
  const policy = ctx.policy;

  // --- Package runners: classify the package they execute --------------------
  const runner = packageRunnerTarget(head, argv);
  if (runner) {
    const sub: SimpleCommand = { ...seg, argv: runner, raw: runner.join(' ') };
    const cls = classifySegment(sub, commandName(runner[0]), cwd, env, normalized, hits);
    if (cls.kind === 'safe') return { kind: 'unknown', hit: { code: 'UNKNOWN_COMMAND', rule: 'shell.package_runner', reason: `${head} downloads and runs ${runner[0]}; add it to allow.commands to permit it`, matched: text } };
    return cls;
  }

  // --- Supervisor tamper -------------------------------------------------
  if (C.AGENT_HEADS.has(head)) {
    hits.push({ code: 'SUPERVISOR_TAMPER', rule: 'agent.nested', reason: `launching another coding agent (${head}) would run unguarded`, matched: text });
    return { kind: 'unknown' };
  }
  if ((head === 'unset' || head === 'export') && argv.slice(1).some((a) => /^(NIGHTWATCH_|CLAUDE_CONFIG|CLAUDE_CODE_)/.test(a))) {
    hits.push({ code: 'SUPERVISOR_TAMPER', rule: 'env.unset', reason: 'modifies supervisor environment variables', matched: text });
    return { kind: 'unknown' };
  }

  // --- Hard destructive classes ------------------------------------------
  if (C.DESTRUCTIVE_HEADS.has(head)) {
    if (head === 'dd') {
      const of = argv.find((a) => a.startsWith('of='));
      if (of && !DEV_DISK_RE.test(of.slice(3))) {
        const chk = checkPath(of.slice(3), cwd, env, 'write', normalized);
        if (chk) hits.push(chk);
        const inf = argv.find((a) => a.startsWith('if='));
        if (inf && !/^\/dev\/(zero|urandom|random|null)$/.test(inf.slice(3))) {
          const chk2 = checkPath(inf.slice(3), cwd, env, 'read', normalized);
          if (chk2) hits.push(chk2);
        }
        return { kind: 'safe' };
      }
    }
    if (head === 'kill' && argv.length === 1) return { kind: 'safe' };
    hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: `destructive.${head}`, reason: `${head} can damage the system or terminate processes`, matched: text });
    return { kind: 'unknown' };
  }
  if (C.SYSTEM_PACKAGE_HEADS.has(head)) {
    if (isReadOnlyPackageManagerCall(head, argv)) return { kind: 'safe' };
    hits.push({ code: 'OUTSIDE_WORKTREE', rule: `syspkg.${head}`, reason: `${head} modifies the machine, not the project`, matched: text });
    return { kind: 'unknown' };
  }
  if (isVersionOrHelp(argv)) return { kind: 'safe' };

  // --- Secrets -----------------------------------------------------------
  if (C.SECRET_DUMP_HEADS.has(head)) {
    if (head === 'printenv' && pos.length && !pos.some((p) => C.SECRET_ENV_RE.test(`$${p}`))) return { kind: 'safe' };
    if (head === 'gpg' && !argv.some((a) => /--export-secret|--decrypt|-d$/.test(a))) return { kind: 'unknown' };
    hits.push({ code: 'SECRET_PATH', rule: `secret.${head}`, reason: `${head} exposes credentials or environment secrets`, matched: text });
    return { kind: 'unknown' };
  }
  if ((head === 'env' || head === 'set' || head === 'export' || head === 'declare' || head === 'typeset') && (argv.length === 1 || argv[1] === '-p' || argv[1] === '-x')) {
    if (head === 'set' && argv.length > 1 && argv[1] !== '-p') return { kind: 'safe' };
    hits.push({ code: 'SECRET_PATH', rule: 'secret.envdump', reason: `${head} dumps the whole environment, which may contain secrets`, matched: text });
    return { kind: 'unknown' };
  }
  if ((head === 'gh' && /^auth token/.test(pos.join(' '))) || (head === 'gcloud' && /auth (print|application-default print)/.test(pos.join(' '))) || (head === 'aws' && /^(configure get|sts get-session-token|configure export)/.test(pos.join(' '))) || (head === 'az' && /account get-access-token/.test(pos.join(' '))) || (head === 'git' && pos[0] === 'credential') || (head === 'npm' && pos[0] === 'token') || (head === 'docker' && pos[0] === 'login')) {
    hits.push({ code: 'SECRET_PATH', rule: 'secret.cli', reason: `${text.split(' ').slice(0, 3).join(' ')} reveals or stores credentials`, matched: text });
    return { kind: 'unknown' };
  }
  // Path arguments of any command are checked for secrets and protected paths.
  const candidates = pathCandidates(seg, head, cwd);
  for (const c of candidates) {
    const abs = safeCanon(c, cwd, env);
    if (!abs) continue;
    const prot = head === 'cd' || head === 'pushd' ? null : env.protectedMatch(abs);
    if (prot) {
      hits.push({ code: 'SUPERVISOR_TAMPER', rule: 'path.protected', reason: `touches supervisor configuration ${shortPath(abs, env)} (${prot})`, matched: c });
    }
    const sec = env.secretMatch(abs) ?? env.secretMatch(c.replace(/^~/, env.home));
    if (sec && !C.SECRET_EXCEPTION_RE.test(path.basename(abs))) {
      hits.push({ code: 'SECRET_PATH', rule: 'path.secret', reason: `${shortPath(abs, env)} matches deny.paths pattern "${sec}"`, matched: c });
    }
  }

  // --- Prod / deploy ------------------------------------------------------
  if (C.PROD_HEADS.has(head)) {
    if (head === 'terraform' || head === 'tofu') {
      /* handled below */
    } else {
      hits.push({ code: 'PROD_RISK', rule: `prod.${head}`, reason: `${head} deploys, publishes or manages cloud resources`, matched: text });
      return { kind: 'unknown' };
    }
  }
  if (C.DB_CLIENT_HEADS.has(head)) {
    if (head === 'sqlite3' || head === 'duckdb' || head === 'litecli') {
      // local file databases: path rule only
      for (const c of candidates) {
        const chk = checkPath(c, cwd, env, 'write', normalized);
        if (chk) hits.push(chk);
      }
      return { kind: 'unknown' };
    }
    const hosts = dbHosts(argv);
    if (hosts.length && hosts.every(isLoopbackHost)) return { kind: 'unknown' };
    hits.push({ code: 'PROD_RISK', rule: `db.${head}`, reason: hosts.length ? `database client targets ${hosts.join(', ')}` : `database client ${head} without an explicit loopback host`, matched: text });
    return { kind: 'unknown' };
  }
  if (head === 'terraform' || head === 'tofu' || head === 'terragrunt') {
    if (/^(apply|destroy|import|state|taint|untaint|workspace delete|force-unlock)/.test(pos.join(' '))) {
      hits.push({ code: 'PROD_RISK', rule: 'prod.terraform', reason: `${head} ${pos[0]} changes infrastructure`, matched: text });
    }
    return { kind: 'unknown' };
  }
  if (head === 'kubectl') {
    if (!/^(get|describe|logs|explain|version|api-resources|api-versions|config view|config current-context|config get-contexts|top|diff|cluster-info|auth can-i)/.test(pos.join(' '))) {
      hits.push({ code: 'PROD_RISK', rule: 'prod.kubectl', reason: `kubectl ${pos[0] ?? ''} changes cluster state`, matched: text });
    }
    return { kind: 'unknown' };
  }
  if (head === 'gh' || head === 'glab') {
    const sub = pos.slice(0, 2).join(' ');
    const readOnly = /^(pr (view|list|status|diff|checks)|issue (view|list|status)|repo view|run (view|list|watch)|release (list|view)|api|search|browse|auth status|label list|gist view|gist list|workflow (list|view)|status|--version)/.test(sub) || pos[0] === 'api';
    const apiMutates = pos[0] === 'api' && argv.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input)$/.test(a) || /^(-X|--method)=/.test(a)) && !argv.some((a) => /^GET$/i.test(a));
    if (!readOnly || apiMutates) {
      hits.push({ code: 'PROD_RISK', rule: `prod.${head}`, reason: `${head} ${pos.slice(0, 2).join(' ')} mutates a remote repository or release`, matched: text });
      return { kind: 'unknown' };
    }
    return networkOrAllowed(['github.com', 'api.github.com', 'gitlab.com'], head, text, env, normalized);
  }
  if (head === 'npm' || head === 'yarn' || head === 'pnpm' || head === 'bun') {
    const sub = pos[0] ?? '';
    if (/^(publish|unpublish|deprecate|owner|access|token|login|adduser|logout|dist-tag|hook|org|team|star|unstar)$/.test(sub) || (head === 'yarn' && sub === 'npm' && /^(publish|login|logout|tag)$/.test(pos[1] ?? ''))) {
      hits.push({ code: 'PROD_RISK', rule: 'prod.npm', reason: `${head} ${sub} publishes or changes registry account state`, matched: text });
      return { kind: 'unknown' };
    }
    if (sub === 'config' && /^(set|delete|edit)$/.test(pos[1] ?? '')) {
      hits.push({ code: 'SUPERVISOR_TAMPER', rule: 'tamper.npmconfig', reason: `${head} config ${pos[1]} changes registry or auth configuration`, matched: text });
      return { kind: 'unknown' };
    }
    if (hasFlag(argv, ['g'], ['--global', '--location=global']) || sub === 'link') {
      hits.push({ code: 'OUTSIDE_WORKTREE', rule: 'outside.npmglobal', reason: `${head} global install/link modifies the machine`, matched: text });
      return { kind: 'unknown' };
    }
  }
  if ((head === 'pip' || head === 'pip3' || head === 'uv' || head === 'poetry' || head === 'twine' || head === 'cargo' || head === 'gem' || head === 'dotnet' || head === 'mvn' || head === 'gradle' || head === 'gradlew') && /^(publish|upload|push|deploy|yank|release)/.test(pos.join(' ')) || (head === 'gradlew' && /publish/i.test(text))) {
    hits.push({ code: 'PROD_RISK', rule: `prod.${head}`, reason: `${head} ${pos[0]} publishes a package`, matched: text });
    return { kind: 'unknown' };
  }
  if ((head === 'pip' || head === 'pip3') && pos[0] === 'config' && /^(set|unset|edit)$/.test(pos[1] ?? '')) {
    hits.push({ code: 'SUPERVISOR_TAMPER', rule: 'tamper.pipconfig', reason: 'pip config changes index/auth configuration', matched: text });
    return { kind: 'unknown' };
  }
  if (/^(prisma|rails|bin\/rails|rake|knex|sequelize|typeorm|flyway|liquibase|alembic|php artisan|artisan|mix|ecto)/.test(text) && /(migrate deploy|db push|migrate reset|db:drop|db:reset|db:purge|migrate:fresh|migrate:reset|migrate:rollback|clean\b|drop-all|downgrade base|ecto\.drop|ecto\.reset|--force)/.test(text)) {
    hits.push({ code: 'PROD_RISK', rule: 'prod.migration', reason: 'destructive database migration command', matched: text });
    return { kind: 'unknown' };
  }
  if (head === 'docker' || head === 'podman' || head === 'nerdctl' || head === 'docker-compose') {
    const sub = head === 'docker-compose' ? `compose ${pos[0] ?? ''}` : pos.slice(0, 2).join(' ');
    if (/^(push|login|logout|manifest push|buildx .*--push)/.test(sub) || argv.includes('--push')) {
      hits.push({ code: 'PROD_RISK', rule: 'prod.docker', reason: 'pushes an image to a registry', matched: text });
      return { kind: 'unknown' };
    }
    if (/^(system prune|volume (rm|prune)|image prune|container prune|network prune|rmi|rm -f|kill|stop -a)/.test(sub) || (/^(rm|rmi|kill)/.test(sub) && hasFlag(argv, ['f'], ['--force']))) {
      hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'destructive.docker', reason: 'removes or kills host-wide Docker resources', matched: text });
      return { kind: 'unknown' };
    }
    if (/^compose down/.test(sub) && (argv.includes('-v') || argv.includes('--volumes'))) {
      hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'destructive.compose_volumes', reason: 'compose down -v deletes volumes', matched: text });
      return { kind: 'unknown' };
    }
    if (argv.includes('--privileged') || argv.some((a) => /^--(pid|network|ipc|userns)=host$/.test(a)) || argv.some((a, i) => (a === '-v' || a === '--volume' || a === '--mount') && /^\/(:|$)|\/var\/run\/docker\.sock/.test(argv[i + 1] ?? '')) || argv.some((a) => /^-v\/(:|$)/.test(a))) {
      hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'destructive.docker_escape', reason: 'privileged container or host filesystem mount', matched: text });
      return { kind: 'unknown' };
    }
    if ((/^(run|compose up|compose run|start)/.test(sub) && (argv.includes('-d') || argv.includes('--detach') || argv.some((a) => /^-[a-zA-Z]*d[a-zA-Z]*$/.test(a) && a !== '-d' && /^-[itd]+$/.test(a)))) && policy.deny.detached_processes) {
      hits.push({ code: 'DETACHED_PROCESS', rule: 'detached.docker', reason: 'starts a detached container', matched: text });
      return { kind: 'unknown' };
    }
    return { kind: 'unknown' };
  }
  if (head === 'systemctl' || head === 'service' || head === 'launchctl' || head === 'sc' || head === 'net') {
    if (head === 'systemctl' && /^(status|show|list-units|list-unit-files|is-active|is-enabled|cat|list-timers|--version)/.test(pos.join(' '))) return { kind: 'safe' };
    hits.push({ code: 'DETACHED_PROCESS', rule: `detached.${head}`, reason: `${head} manages system services`, matched: text });
    return { kind: 'unknown' };
  }
  if (C.DETACH_HEADS.has(head) && policy.deny.detached_processes) {
    if (head === 'tmux' && pos[0] === 'ls') return { kind: 'safe' };
    hits.push({ code: 'DETACHED_PROCESS', rule: `detached.${head}`, reason: `${head} starts processes the supervisor cannot see or opens external applications`, matched: text });
    return { kind: 'unknown' };
  }

  // --- Shell interpreters ------------------------------------------------
  if (C.SHELL_HEADS.has(head)) {
    if (seg.pipedFrom && pos.length === 0) {
      hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'shell.pipe_to_shell', reason: 'executes a program piped from another command (e.g. curl | sh)', matched: text });
      return { kind: 'unknown' };
    }
    if (pos.length) {
      // `bash script.sh` — the script is project code; check readable and treat as unknown.
      const chk = checkPath(pos[0], cwd, env, 'read', normalized);
      if (chk) hits.push(chk);
    }
    return { kind: 'unknown' };
  }
  if ((head === 'source' || head === '.') && pos[0]) {
    const chk = checkPath(pos[0], cwd, env, 'read', normalized);
    if (chk) hits.push(chk);
    return { kind: 'unknown' };
  }

  // --- Git ----------------------------------------------------------------
  if (head === 'git') return classifyGit(seg, argv, pos, cwd, env, normalized, hits);

  // --- Network tools -------------------------------------------------------
  if (C.NETWORK_HEADS.has(head)) {
    normalized.flags.network = true;
    const hosts = new Set<string>(hostsFromText(text));
    if (head === 'ssh' || head === 'scp' || head === 'sftp' || head === 'rsync' || head === 'telnet' || head === 'nc' || head === 'ncat' || head === 'netcat' || head === 'ping' || head === 'ping6' || head === 'traceroute' || head === 'mtr' || head === 'nmap') {
      for (const p of pos) {
        const h = hostFromRemoteSpec(p);
        if (h && (p.includes('@') || p.includes(':') || head !== 'scp' && head !== 'rsync')) hosts.add(h);
      }
    }
    if (head === 'curl' || head === 'wget') {
      // output paths
      for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if ((a === '-o' || a === '--output' || a === '-O' && head === 'wget' || a === '--output-document' || a === '-P' || a === '--directory-prefix') && argv[i + 1]) {
          const chk = checkPath(argv[i + 1], cwd, env, 'write', normalized);
          if (chk) hits.push(chk);
        }
        if ((a === '-T' || a === '--upload-file' || a === '-d' || a === '--data' || a === '--data-binary' || a === '-F' || a === '--form') && argv[i + 1]?.startsWith('@')) {
          const chk = checkPath(argv[i + 1].slice(1).split(';')[0], cwd, env, 'read', normalized);
          if (chk) hits.push(chk);
        }
      }
    }
    normalized.hosts.push(...hosts);
    if (hosts.size === 0) {
      return { kind: 'network', hit: { code: 'NETWORK_NOT_ALLOWED', rule: `network.${head}`, reason: `${head} without a recognisable destination host`, matched: text } };
    }
    const denied = [...hosts].filter((h) => !matchDomain(env.domains, h));
    if (denied.length) {
      return { kind: 'network', hit: { code: 'NETWORK_NOT_ALLOWED', rule: `network.${head}`, reason: `${denied.join(', ')} not in allow.domains`, matched: denied.join(', ') } };
    }
    return { kind: 'safe' };
  }

  // --- Filesystem read/write commands -------------------------------------
  if (head === 'cd' || head === 'pushd') {
    // handled below regardless of builtin_safe_commands
  } else if (!policy.allow.builtin_safe_commands) {
    return { kind: 'unknown', hit: { code: 'UNKNOWN_COMMAND', rule: 'shell.builtins_disabled', reason: `built-in safe commands are disabled; "${truncate(text)}" must be in allow.commands`, matched: text } };
  }
  if (head === 'cd' || head === 'pushd') {
    const target = pos[0] ?? env.home;
    const chk = checkPath(target === '-' ? cwd : target, cwd, env, 'cd', normalized);
    if (chk) {
      hits.push(chk);
      return { kind: 'unknown' };
    }
    const abs = safeCanon(target === '-' ? cwd : target, cwd, env) ?? cwd;
    return { kind: 'safe', cd: abs };
  }
  if (head === 'rm' || head === 'unlink') {
    const recursive = hasFlag(argv, ['r', 'R'], ['--recursive']);
    const force = hasFlag(argv, ['f'], ['--force']);
    if (argv.some((a) => a === '--no-preserve-root')) hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'destructive.rm_root', reason: 'rm --no-preserve-root', matched: text });
    if (recursive && force) hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'destructive.rm_rf', reason: 'recursive forced delete (rm -rf)', matched: text });
    for (const p of pos) {
      const abs = safeCanon(p, cwd, env);
      if (abs && isRootLike(abs, env)) hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'destructive.rm_rootlike', reason: `deletes ${abs}`, matched: p });
      const chk = checkPath(p, cwd, env, 'write', normalized);
      if (chk) hits.push(chk);
    }
    if (recursive && pos.some((p) => p === '*' || p === '.' || p === './' || p === '..')) hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'destructive.rm_wildcard', reason: 'recursive delete of the whole directory', matched: text });
    return { kind: 'safe' };
  }
  if (head === 'find') {
    const exprStart = argv.findIndex((a, i) => i > 0 && (a.startsWith('-') || a === '(' || a === '!'));
    const paths = exprStart < 0 ? argv.slice(1) : argv.slice(1, exprStart);
    const expr = exprStart < 0 ? [] : argv.slice(exprStart);
    for (const p of paths.length ? paths : ['.']) {
      const chk = checkPath(p, cwd, env, expr.includes('-delete') ? 'write' : 'read', normalized);
      if (chk) hits.push(chk);
    }
    if (expr.includes('-delete')) hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'destructive.find_delete', reason: 'find -delete removes files recursively', matched: text });
    const execIdx = expr.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir');
    if (execIdx >= 0) {
      const cmd = expr.slice(execIdx + 1);
      const endIdx = cmd.findIndex((a) => a === ';' || a === '+' || a === '\;');
      const execArgv = (endIdx < 0 ? cmd : cmd.slice(0, endIdx)).map((a) => (a === '{}' ? '.' : a));
      if (execArgv.length) {
        const sub: SimpleCommand = { ...seg, argv: execArgv, redirects: [], raw: execArgv.join(' ') };
        const cls = classifySegment(sub, commandName(execArgv[0]), cwd, env, normalized, hits);
        if (cls.kind !== 'safe') return cls;
      }
    }
    return { kind: 'safe' };
  }
  if (head === 'sed' || head === 'perl') {
    const inPlace = head === 'sed' ? argv.some((a) => a === '-i' || a.startsWith('-i') && !a.startsWith('-in') || a.startsWith('--in-place') || /^-[a-zA-Z]*i/.test(a) && a !== '-in') : argv.some((a) => /^-[a-zA-Z]*i/.test(a));
    if (head === 'perl' && !inPlace) return { kind: 'unknown' };
    if (head === 'perl' && argv.some((a) => a === '-e' || a === '-E')) {
      // perl -pi -e 's/x/y/' files → in-place edit; program is code but limited to substitution? Too risky: unknown unless allowed.
      if (!argv.some((a) => /^-[a-zA-Z]*p/.test(a) || /^-[a-zA-Z]*n/.test(a))) return { kind: 'unknown' };
    }
    for (const c of candidates) {
      const chk = checkPath(c, cwd, env, inPlace ? 'write' : 'read', normalized);
      if (chk) hits.push(chk);
    }
    return { kind: head === 'sed' ? 'safe' : 'unknown' };
  }
  if (head === 'awk' || head === 'gawk' || head === 'mawk' || head === 'nawk') {
    const program = argv.some((a) => a === '-f') ? '' : pos[0] ?? '';
    if (/system\s*\(|>\s*"|>\s*\/|\|\s*"/.test(program)) return { kind: 'unknown' };
    for (const c of candidates) {
      const chk = checkPath(c, cwd, env, 'read', normalized);
      if (chk) hits.push(chk);
    }
    return { kind: 'safe' };
  }
  if (head === 'chmod' || head === 'chown' || head === 'chgrp') {
    for (const c of candidates) {
      const abs = safeCanon(c, cwd, env);
      if (abs && isRootLike(abs, env)) hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: `destructive.${head}_root`, reason: `${head} on ${abs}`, matched: c });
      const chk = checkPath(c, cwd, env, 'write', normalized);
      if (chk) hits.push(chk);
    }
    return { kind: 'safe' };
  }
  if (head === 'mv' || head === 'cp' || head === 'ln' || head === 'install' || head === 'rsync' || head === 'ditto') {
    if (pos.some((p) => p === '/dev/null')) hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'destructive.mv_devnull', reason: 'moves files into /dev/null', matched: text });
    const targets = pos.filter((p) => !p.startsWith('/dev/'));
    for (let i = 0; i < targets.length; i++) {
      const isDest = i === targets.length - 1 && targets.length > 1;
      const chk = checkPath(targets[i], cwd, env, isDest || head === 'mv' ? 'write' : 'read', normalized);
      if (chk) hits.push(chk);
    }
    return { kind: 'safe' };
  }
  if (head === 'tar' || head === 'unzip' || head === 'zip' || head === '7z' || head === '7za') {
    let dest: string | null = null;
    for (let i = 1; i < argv.length; i++) {
      if ((argv[i] === '-C' || argv[i] === '--directory' || argv[i] === '-d') && argv[i + 1]) dest = argv[i + 1];
      if (argv[i].startsWith('-o') && head.startsWith('7z') && argv[i].length > 2) dest = argv[i].slice(2);
    }
    if (dest) {
      const chk = checkPath(dest, cwd, env, 'write', normalized);
      if (chk) hits.push(chk);
    }
    for (const c of candidates) {
      const chk = checkPath(c, cwd, env, 'write', normalized);
      if (chk) hits.push(chk);
    }
    return { kind: 'safe' };
  }
  if (C.WRITE_HEADS.has(head)) {
    for (const c of candidates) {
      const chk = checkPath(c, cwd, env, 'write', normalized);
      if (chk) hits.push(chk);
    }
    return { kind: 'safe' };
  }
  if (C.READ_HEADS.has(head)) {
    if (head === 'history' && argv.includes('-c')) return { kind: 'safe' };
    for (const c of candidates) {
      const chk = checkPath(c, cwd, env, 'read', normalized);
      if (chk) hits.push(chk);
    }
    if (head === 'echo' || head === 'printf') return { kind: 'safe' };
    return { kind: 'safe' };
  }

  // --- Toolchain introspection --------------------------------------------
  if (policy.allow.builtin_safe_commands && matchesAnyCommand(C.TOOLCHAIN_SAFE_PATTERNS, text)) {
    if (/^gh /.test(text)) return networkOrAllowed(['github.com', 'api.github.com'], head, text, env, normalized);
    return { kind: 'safe' };
  }

  // Unknown command: still check any obvious path arguments for containment of writes we can infer.
  return { kind: 'unknown', hit: { code: 'UNKNOWN_COMMAND', rule: 'shell.unknown', reason: `"${truncate(text)}" is not a recognised safe command and is not in allow.commands`, matched: text } };
}

function networkOrAllowed(hosts: string[], head: string, text: string, env: Env, normalized: NormalizedCall): Classification {
  normalized.flags.network = true;
  normalized.hosts.push(...hosts);
  if (hosts.some((h) => matchDomain(env.domains, h))) return { kind: 'safe' };
  return { kind: 'network', hit: { code: 'NETWORK_NOT_ALLOWED', rule: `network.${head}`, reason: `${head} contacts ${hosts[0]} which is not in allow.domains`, matched: text } };
}

function classifyGit(seg: SimpleCommand, argv: string[], pos: string[], cwd: string, env: Env, normalized: NormalizedCall, hits: Hit[]): Classification {
  const text = segmentText(seg);
  // Global options before the subcommand: -C <path>, -c key=val, --git-dir=…
  let i = 1;
  let gitCwd = cwd;
  while (i < argv.length && argv[i].startsWith('-')) {
    const a = argv[i];
    if (a === '-C' && argv[i + 1]) {
      const chk = checkPath(argv[i + 1], cwd, env, 'cd', normalized);
      if (chk) hits.push(chk);
      gitCwd = safeCanon(argv[i + 1], cwd, env) ?? cwd;
      i += 2;
      continue;
    }
    if (a === '-c' && argv[i + 1]) {
      if (/^(core\.hooksPath|core\.sshCommand|credential\.|alias\.|http\.|url\.|core\.fsmonitor|core\.pager|core\.editor|diff\.external|filter\.)/i.test(argv[i + 1])) {
        hits.push({ code: 'SUPERVISOR_TAMPER', rule: 'git.config_inline', reason: `git -c ${argv[i + 1].split('=')[0]} can execute arbitrary commands or redirect credentials`, matched: text });
      }
      i += 2;
      continue;
    }
    if (a.startsWith('--git-dir') || a.startsWith('--work-tree')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i];
      if (v) {
        const chk = checkPath(v, cwd, env, 'write', normalized);
        if (chk) hits.push(chk);
      }
    }
    i++;
  }
  const sub = argv[i] ?? '';
  const rest = argv.slice(i + 1);
  const restPos = positionals(['git', ...rest]);
  const r = rest.join(' ');

  if (!sub) return { kind: 'safe' };
  if (sub === 'push') {
    hits.push({ code: 'PROD_RISK', rule: 'git.push', reason: 'git push publishes to a remote', matched: text });
    return { kind: 'unknown' };
  }
  if (sub === 'remote' && rest.length && !/^(-v|--verbose|show|get-url)$/.test(rest[0])) {
    hits.push({ code: 'PROD_RISK', rule: 'git.remote', reason: `git remote ${rest[0]} changes where code is published`, matched: text });
    return { kind: 'unknown' };
  }
  if (sub === 'worktree' && rest[0] !== 'list') {
    hits.push({ code: 'SUPERVISOR_TAMPER', rule: 'git.worktree', reason: 'git worktree changes the isolation Nightwatch relies on', matched: text });
    return { kind: 'unknown' };
  }
  if (sub === 'reset' && /(^|\s)--hard(\s|$)/.test(r) || sub === 'reset' && /(^|\s)--merge(\s|$)/.test(r)) {
    hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'git.reset_hard', reason: 'git reset --hard discards uncommitted work', matched: text });
    return { kind: 'unknown' };
  }
  if (sub === 'clean' && (hasFlag(['git', ...rest], ['f', 'x', 'd', 'X'], ['--force']) || rest.length === 0)) {
    hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'git.clean', reason: 'git clean deletes untracked files', matched: text });
    return { kind: 'unknown' };
  }
  if (sub === 'branch' && hasFlag(['git', ...rest], ['D', 'd', 'M', 'm'], ['--delete', '--move', '--force'])) {
    hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'git.branch_delete', reason: 'deletes or renames branches', matched: text });
    return { kind: 'unknown' };
  }
  if (sub === 'switch' || (sub === 'checkout' && restPos.length && !rest.includes('--') && !restPos.every((p) => pathExists(p, gitCwd, env)))) {
    if (sub === 'checkout' && hasFlag(['git', ...rest], ['b', 'B'], ['--orphan'])) {
      hits.push({ code: 'SUPERVISOR_TAMPER', rule: 'git.new_branch', reason: 'creating a new branch leaves the run branch Nightwatch tracks', matched: text });
      return { kind: 'unknown' };
    }
    if (sub === 'switch' && (rest.includes('-c') || rest.includes('--create') || rest.includes('-C'))) {
      hits.push({ code: 'SUPERVISOR_TAMPER', rule: 'git.new_branch', reason: 'creating a new branch leaves the run branch Nightwatch tracks', matched: text });
      return { kind: 'unknown' };
    }
    hits.push({ code: 'SUPERVISOR_TAMPER', rule: 'git.switch', reason: 'switching branches leaves the run branch Nightwatch tracks', matched: text });
    return { kind: 'unknown' };
  }
  if (sub === 'config') {
    if (rest.includes('--global') || rest.includes('--system')) {
      hits.push({ code: 'OUTSIDE_WORKTREE', rule: 'git.config_global', reason: 'git config --global/--system modifies the user account', matched: text });
      return { kind: 'unknown' };
    }
    const key = restPos.find((p) => p.includes('.')) ?? '';
    const isRead = rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--get-urlmatch)$/.test(a)) || (restPos.length === 1 && !rest.includes('--unset'));
    if (!isRead && /^(core\.hooksPath|core\.sshCommand|credential\.|alias\.|http\.|url\.|core\.fsmonitor|core\.pager|core\.editor|diff\.external|filter\.|include\.|includeIf\.|remote\.)/i.test(key)) {
      hits.push({ code: 'SUPERVISOR_TAMPER', rule: 'git.config_dangerous', reason: `git config ${key} can execute commands or redirect pushes/credentials`, matched: text });
      return { kind: 'unknown' };
    }
    if (key.startsWith('credential') && isRead) {
      hits.push({ code: 'SECRET_PATH', rule: 'git.config_credential', reason: 'reads git credential configuration', matched: text });
      return { kind: 'unknown' };
    }
    return { kind: 'safe' };
  }
  if (sub === 'stash' && /^(drop|clear)$/.test(rest[0] ?? '')) {
    hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: 'git.stash_drop', reason: 'discards stashed work', matched: text });
    return { kind: 'unknown' };
  }
  if (/^(filter-branch|filter-repo|replace|update-ref|reflog|gc|prune|repack|pack-refs|maintenance|svn|send-email|instaweb|daemon|fast-import|credential.*)$/.test(sub) && !(sub === 'reflog' && (rest.length === 0 || rest[0] === 'show'))) {
    hits.push({ code: 'DESTRUCTIVE_COMMAND', rule: `git.${sub}`, reason: `git ${sub} rewrites or expires history`, matched: text });
    return { kind: 'unknown' };
  }
  if (C.GIT_NETWORK_SUBCOMMANDS.has(sub) || (sub === 'submodule' && /^(update|add|sync)/.test(rest.join(' ')) && !rest.includes('--no-fetch'))) {
    normalized.flags.network = true;
    const hosts = hostsFromText(r);
    for (const p of restPos) {
      const h = hostFromRemoteSpec(p);
      if (h && p.includes('@')) hosts.push(h);
    }
    normalized.hosts.push(...hosts);
    if (hosts.length && hosts.every((h) => matchDomain(env.domains, h))) return { kind: 'safe' };
    return { kind: 'network', hit: { code: 'NETWORK_NOT_ALLOWED', rule: `network.git_${sub}`, reason: hosts.length ? `${hosts.join(', ')} not in allow.domains` : `git ${sub} contacts a remote whose host is not visible in the command`, matched: text } };
  }
  if (sub === 'rebase' && rest.some((a) => a === '-i' || a === '--interactive')) return { kind: 'unknown' };
  // Path arguments for in-worktree operations
  for (const p of restPos) {
    if (!looksLikePath(p, gitCwd)) continue;
    const write = C.GIT_WRITE_SUBCOMMANDS.has(sub);
    const chk = checkPath(p, gitCwd, env, write ? 'write' : 'read', normalized);
    if (chk) hits.push(chk);
  }
  for (let k = 0; k < rest.length; k++) {
    if ((rest[k] === '-o' || rest[k] === '--output' || rest[k] === '--output-directory') && rest[k + 1]) {
      const chk = checkPath(rest[k + 1], gitCwd, env, 'write', normalized);
      if (chk) hits.push(chk);
    }
  }
  if (sub === 'init' && restPos[0]) {
    const chk = checkPath(restPos[0], gitCwd, env, 'write', normalized);
    if (chk) hits.push(chk);
  }
  if (C.GIT_READ_SUBCOMMANDS.has(sub) || C.GIT_WRITE_SUBCOMMANDS.has(sub)) return { kind: 'safe' };
  return { kind: 'unknown' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** For `npx pkg …`, `pnpm dlx pkg …`, `yarn dlx …`, `bunx …`, `uvx …`, `pipx run …` return the argv of the executed package. */
function packageRunnerTarget(head: string, argv: string[]): string[] | null {
  let rest: string[] | null = null;
  if (head === 'npx' || head === 'bunx' || head === 'pnpx' || head === 'uvx') rest = argv.slice(1);
  else if ((head === 'pnpm' || head === 'yarn') && argv[1] === 'dlx') rest = argv.slice(2);
  else if (head === 'pipx' && argv[1] === 'run') rest = argv.slice(2);
  else if (head === 'npm' && argv[1] === 'exec') rest = argv.slice(2);
  if (!rest) return null;
  while (rest.length && rest[0].startsWith('-')) {
    const a = rest[0];
    if ((a === '-p' || a === '--package' || a === '-c' || a === '--call') && rest[1]) rest = rest.slice(2);
    else rest = rest.slice(1);
  }
  if (rest[0] === '--') rest = rest.slice(1);
  return rest.length ? rest : null;
}

function isVersionOrHelp(argv: string[]): boolean {
  const args = argv.slice(1);
  return args.length > 0 && args.every((a) => VERSION_ARGS.has(a));
}

function isReadOnlyPackageManagerCall(head: string, argv: string[]): boolean {
  const pos = positionals(argv);
  const sub = pos[0] ?? '';
  return /^(list|info|show|search|--version|-v|version|config|doctor|outdated|deps|leaves|which|policy|depends|rdepends|query|-Q|-Qi|-Ss|-Si|--help)$/.test(sub) && !argv.some((a) => /^(--?write|set)$/.test(a));
}

function connectionStringHit(text: string): Hit | null {
  for (const m of text.matchAll(C.CONNECTION_STRING_RE)) {
    const host = hostFromUrl(m[0].replace(/^jdbc:[a-z]+:/, ''));
    if (host && isLoopbackHost(host)) continue;
    return { code: 'PROD_RISK', rule: 'raw.connection_string', reason: `production-like connection string for ${host ?? m[1]}`, matched: m[0] };
  }
  return null;
}

function dbHosts(argv: string[]): string[] {
  const hosts: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '-h' || a === '--host' || a === '-H' || a === '--hostname') && argv[i + 1]) hosts.push(argv[i + 1].toLowerCase());
    else if (a.startsWith('--host=') || a.startsWith('-h') && a.length > 2 && !a.startsWith('--')) hosts.push(a.replace(/^(--host=|-h)/, '').toLowerCase());
    else if (a.startsWith('host=')) hosts.push(a.slice(5).toLowerCase());
    for (const h of hostsFromText(a)) hosts.push(h);
  }
  return hosts;
}

function isRootLike(abs: string, env: Env): boolean {
  const n = abs.replace(/\\/g, '/').replace(/\/+$/, '');
  if (n === '' || /^[A-Za-z]:$/.test(n)) return true; // filesystem root
  if (isSame(abs, env.home, env.platform)) return true;
  if (isSame(abs, env.ctx.projectRoot, env.platform)) return true;
  if (isSame(abs, env.ctx.runWorktree, env.platform)) return true;
  if (/(^|\/)\.git$/.test(n)) return true;
  return false;
}

function isSame(a: string, b: string, platform: NodeJS.Platform): boolean {
  return isPathInside(a, b, platform) && isPathInside(b, a, platform);
}

function safeCanon(p: string, cwd: string, env: Env): string | null {
  try {
    return canonicalizePath(p, cwd, env.home).path;
  } catch {
    return null;
  }
}

function pathExists(p: string, cwd: string, env: Env): boolean {
  try {
    return canonicalizePath(p, cwd, env.home).exists;
  } catch {
    return false;
  }
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function looksLikePath(tok: string, cwd: string): boolean {
  if (!tok || tok === '-' || SCHEME_RE.test(tok)) return false;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(tok)) return false; // user@host:path
  if (tok.includes('/') || tok.includes('\\')) return true;
  if (tok.startsWith('~') || tok.startsWith('.')) return true;
  if (/^[A-Za-z]:/.test(tok)) return true;
  try {
    return canonicalizePath(tok, cwd).exists;
  } catch {
    return false;
  }
}

/** Heuristic extraction of path-like arguments from a simple command. */
function pathCandidates(seg: SimpleCommand, head: string, cwd: string): string[] {
  const argv = seg.argv;
  const out: string[] = [];
  let skipFirstPositional = false;
  if (['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack'].includes(head) && !argv.some((a) => a === '-e' || a === '--regexp' || a.startsWith('--regexp=') || a === '-f')) skipFirstPositional = true;
  if (head === 'sed' && !argv.some((a) => a === '-e' || a === '-f' || a.startsWith('--expression'))) skipFirstPositional = true;
  if (['awk', 'gawk', 'mawk', 'nawk'].includes(head) && !argv.includes('-f')) skipFirstPositional = true;
  if (['jq', 'yq', 'chmod', 'chown', 'chgrp', 'expr', 'seq', 'printf', 'test', '[', 'let', 'export', 'unset', 'alias', 'type', 'which', 'hash'].includes(head)) skipFirstPositional = true;
  if (head === 'echo' || head === 'printf') return out;
  let sawPositional = false;
  let afterDashDash = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!afterDashDash && a === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && a.startsWith('-') && a !== '-') {
      const eq = a.indexOf('=');
      if (eq > 0) {
        const v = a.slice(eq + 1);
        if (looksLikePath(v, cwd) && (v.includes('/') || v.includes('\\') || v.startsWith('~') || v.startsWith('.'))) out.push(v);
      }
      continue;
    }
    if (skipFirstPositional && !sawPositional) {
      sawPositional = true;
      continue;
    }
    sawPositional = true;
    if (/^\d+$/.test(a)) continue;
    if (looksLikePath(a, cwd)) out.push(a);
  }
  return out;
}

function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export type { Decision };
