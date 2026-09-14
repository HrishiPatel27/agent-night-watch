import { looksLikeTestCommand, parseTestOutput } from '@nightwatch-agent/daemon';
import { evaluate } from '@nightwatch-agent/policy';
import { digest, REASON_TEXT, redactText, summarizeToolInput, truncate, type Decision, type PolicyDecision, type ReasonCode } from '@nightwatch-agent/shared';
import { selectAdapter, type Adapter, type HookResponse, type J, type NormalizedHook } from './adapters/index.js';
import { contextFor, lookupSession, type ResolvedSession } from './session.js';

export interface HandleResult extends HookResponse {
  decision?: PolicyDecision;
  adapter: string;
  supervised: boolean;
}

/**
 * Process one hook invocation end to end. Never throws: every failure path
 * turns into a deny so the agent cannot proceed unsupervised.
 */
export function handleHook(adapterName: string | undefined, stdin: string, env: NodeJS.ProcessEnv = process.env): HandleResult {
  let raw: J;
  try {
    raw = JSON.parse(stdin) as J;
    if (!raw || typeof raw !== 'object') throw new Error('payload is not an object');
  } catch (err) {
    const adapter = safeAdapter(adapterName, {});
    const reason = `${REASON_TEXT.MALFORMED_INPUT}: ${(err as Error).message}`;
    recordParseFailure(env, reason);
    const r = adapter.respond('deny', 'MALFORMED_INPUT', reason, { phase: 'pre', event: 'PreToolUse', tool: 'unknown' });
    return { ...r, exitCode: r.exitCode || 2, stderr: r.stderr ?? `[Nightwatch MALFORMED_INPUT] ${reason}`, adapter: adapter.id, supervised: true };
  }
  const adapter = safeAdapter(adapterName, raw);
  let hook: NormalizedHook;
  try {
    hook = adapter.normalize(raw);
  } catch (err) {
    const reason = `${REASON_TEXT.MALFORMED_INPUT}: ${(err as Error).message}`;
    const r = adapter.respond('deny', 'MALFORMED_INPUT', reason, { phase: 'pre', event: 'PreToolUse' });
    return { ...r, adapter: adapter.id, supervised: true };
  }
  return withSession(adapter, hook, env);
}

function safeAdapter(name: string | undefined, raw: J): Adapter {
  try {
    return selectAdapter(name, raw);
  } catch {
    return selectAdapter('claude-code', raw);
  }
}

function withSession(adapter: Adapter, hook: NormalizedHook, env: NodeJS.ProcessEnv): HandleResult {
  let lookup: ReturnType<typeof lookupSession>;
  try {
    lookup = lookupSession(hook.cwd, env);
  } catch (err) {
    const reason = `${REASON_TEXT.SESSION_INACTIVE}: ${(err as Error).message}`;
    return { ...adapter.respond('deny', 'SESSION_INACTIVE', reason, hook), adapter: adapter.id, supervised: true };
  }
  if (lookup.kind === 'none') {
    return { ...adapter.respond('allow', 'BUILTIN_SAFE', 'not supervised', hook), adapter: adapter.id, supervised: false };
  }
  if (lookup.kind === 'deny') {
    return { ...adapter.respond('deny', 'SESSION_INACTIVE', `${REASON_TEXT.SESSION_INACTIVE}: ${lookup.reason}`, hook), adapter: adapter.id, supervised: true };
  }
  const r = lookup.value;
  try {
    if (hook.phase === 'pre') return { ...handlePre(adapter, hook, r), adapter: adapter.id, supervised: true };
    if (hook.phase === 'post') return { ...handlePost(adapter, hook, r), adapter: adapter.id, supervised: true };
    r.store.insertEvent({ session_id: r.session.id, event: hook.event || 'other', input_summary: hook.agentSessionId ? `agent session ${hook.agentSessionId}` : null });
    return { ...adapter.respond('allow', 'BUILTIN_SAFE', 'recorded', hook), adapter: adapter.id, supervised: true };
  } catch (err) {
    const reason = `${REASON_TEXT.MALFORMED_INPUT}: ${(err as Error).message}`;
    try {
      r.store.insertEvent({ session_id: r.session.id, event: hook.event || 'PreToolUse', tool: hook.tool ?? null, decision: 'deny', reason_code: 'MALFORMED_INPUT', reason_text: reason, rule: 'hook.exception' });
    } catch {
      /* the store itself failed; still deny */
    }
    return { ...adapter.respond('deny', 'MALFORMED_INPUT', reason, hook), adapter: adapter.id, supervised: true };
  } finally {
    r.store.close();
  }
}

function handlePre(adapter: Adapter, hook: NormalizedHook, r: ResolvedSession): HookResponse & { decision: PolicyDecision } {
  const tool = hook.tool ?? 'unknown';
  const input = hook.input ?? {};
  const inputDigest = digest({ tool, input });
  const ctx = contextFor(r, inputDigest);
  const cwd = hook.cwd ?? r.session.worktree;
  const decision = evaluate({ tool, input, cwd }, ctx);
  const shadow = (decision as PolicyDecision & { shadow?: PolicyDecision }).shadow;
  r.store.insertEvent({
    session_id: r.session.id,
    event: 'PreToolUse',
    tool,
    tool_use_id: hook.toolUseId ?? null,
    input_digest: inputDigest,
    input_summary: decision.normalized.summary || summarizeToolInput(tool, input, { extraPatterns: r.policy.redact_patterns }),
    decision: decision.decision,
    reason_code: shadow ? shadow.reasonCode : decision.reasonCode,
    reason_text: decision.reason,
    rule: decision.rule ?? null,
  });
  const effective: Decision = decision.decision;
  return { ...adapter.respond(effective, decision.reasonCode as ReasonCode, decision.reason, hook), decision };
}

function handlePost(adapter: Adapter, hook: NormalizedHook, r: ResolvedSession): HookResponse {
  const tool = hook.tool ?? 'unknown';
  const pre = r.store.findPreEvent(r.session.id, hook.toolUseId ?? null, tool);
  const { summary, ok, exitCode, text } = summarizeResponse(hook.response, r.policy.redact_patterns);
  const durationMs = pre ? Math.max(0, Date.now() - Date.parse(pre.created_at)) : null;
  if (pre) {
    r.store.updateEvent(pre.id, { result_summary: summary, result_ok: ok == null ? null : ok ? 1 : 0, duration_ms: durationMs });
  } else {
    r.store.insertEvent({ session_id: r.session.id, event: 'PostToolUse', tool, tool_use_id: hook.toolUseId ?? null, result_summary: summary, result_ok: ok == null ? null : ok, input_summary: summarizeToolInput(tool, hook.input, { extraPatterns: r.policy.redact_patterns }) });
  }
  if ((tool === 'Bash' || tool === 'PowerShell') && typeof hook.input?.command === 'string' && looksLikeTestCommand(hook.input.command, r.policy.test_command)) {
    const parsed = parseTestOutput(hook.input.command, text, exitCode);
    r.store.insertTestRun({
      session_id: r.session.id,
      event_id: pre?.id ?? null,
      command: redactText(hook.input.command).slice(0, 500),
      passed: parsed.passed,
      failed: parsed.failed,
      skipped: parsed.skipped,
      ok: parsed.ok ? 1 : 0,
      summary: parsed.summary,
      failures_json: JSON.stringify(parsed.failures.map((f) => redactText(f))),
    });
  }
  return adapter.respond('allow', 'BUILTIN_SAFE', 'recorded', hook);
}

function summarizeResponse(response: unknown, extra: string[]): { summary: string; ok: boolean | null; exitCode: number | null; text: string } {
  let text = '';
  let ok: boolean | null = null;
  let exitCode: number | null = null;
  if (typeof response === 'string') text = response;
  else if (response && typeof response === 'object') {
    const o = response as J;
    const stdout = typeof o.stdout === 'string' ? o.stdout : typeof o.output === 'string' ? o.output : typeof o.content === 'string' ? o.content : '';
    const stderr = typeof o.stderr === 'string' ? o.stderr : '';
    text = stdout + (stderr ? `\n${stderr}` : '');
    if (!text && Array.isArray(o.content)) text = o.content.map((c) => (typeof c === 'string' ? c : typeof (c as J)?.text === 'string' ? String((c as J).text) : '')).join('\n');
    if (typeof o.exit_code === 'number') exitCode = o.exit_code;
    else if (typeof o.exitCode === 'number') exitCode = o.exitCode;
    else if (typeof o.returncode === 'number') exitCode = o.returncode;
    if (exitCode != null) ok = exitCode === 0;
    else if (o.is_error === true || o.isError === true || o.interrupted === true || o.error) ok = false;
    else if (typeof o.success === 'boolean') ok = o.success;
    if (!text) text = truncate(JSON.stringify(o), 2000);
  }
  const redacted = redactText(text, { extraPatterns: extra });
  const tail = redacted.length > 600 ? `…${redacted.slice(-600)}` : redacted;
  const summary = `${exitCode != null ? `exit ${exitCode}; ` : ''}${tail.replace(/\s+/g, ' ').trim()}`.slice(0, 700);
  return { summary, ok, exitCode, text: redacted };
}

function recordParseFailure(env: NodeJS.ProcessEnv, reason: string): void {
  try {
    const lookup = lookupSession(undefined, env);
    if (lookup.kind === 'session') {
      lookup.value.store.insertEvent({ session_id: lookup.value.session.id, event: 'PreToolUse', decision: 'deny', reason_code: 'MALFORMED_INPUT', reason_text: reason, rule: 'hook.parse' });
      lookup.value.store.close();
    }
  } catch {
    /* nothing more we can do */
  }
}
