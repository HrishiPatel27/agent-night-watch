import { canonicalTool } from '../tool-map.js';
import { denyText, type Adapter, type NormalizedHook } from './types.js';

export const copilotCli: Adapter = {
  id: 'copilot-cli',
  detect(raw) {
    return typeof raw.toolName === 'string' && raw.toolArgs !== undefined && typeof raw.sessionId === 'string';
  },
  normalize(raw): NormalizedHook {
    const event = String(raw.hookEventName ?? raw.hook_event_name ?? raw.event ?? (raw.toolResult !== undefined || raw.toolOutput !== undefined ? 'postToolUse' : 'preToolUse'));
    const { tool, input } = canonicalTool(String(raw.toolName ?? ''), raw.toolArgs);
    const phase = /^pre/i.test(event) ? 'pre' : /^post/i.test(event) ? 'post' : raw.toolResult !== undefined ? 'post' : 'pre';
    return {
      phase,
      event,
      tool,
      input,
      toolUseId: typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
      response: raw.toolResult ?? raw.toolOutput ?? raw.result,
      agentSessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
    };
  },
  respond(decision, reasonCode, reason, hook) {
    if (hook.phase !== 'pre') return { stdout: '{}', exitCode: 0 };
    if (decision === 'allow') return { stdout: JSON.stringify({ permissionDecision: 'allow' }), exitCode: 0 };
    return { stdout: JSON.stringify({ permissionDecision: decision === 'defer' ? 'ask' : 'deny', permissionDecisionReason: denyText(reasonCode, reason) }), exitCode: 0 };
  },
};
