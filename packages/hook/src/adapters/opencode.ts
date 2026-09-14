import { canonicalTool } from '../tool-map.js';
import { denyText, type Adapter, type NormalizedHook } from './types.js';

/** Payload produced by the Nightwatch OpenCode plugin (see daemon/agents.ts). */
export const opencode: Adapter = {
  id: 'opencode',
  detect(raw) {
    return typeof raw.hook_event_name === 'string' && raw.hook_event_name.startsWith('tool.execute.');
  },
  normalize(raw): NormalizedHook {
    const event = String(raw.hook_event_name ?? '');
    const { tool, input } = canonicalTool(String(raw.tool ?? ''), raw.args);
    return {
      phase: event === 'tool.execute.before' ? 'pre' : event === 'tool.execute.after' ? 'post' : 'other',
      event,
      tool,
      input,
      toolUseId: typeof raw.callID === 'string' ? raw.callID : undefined,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
      response: raw.output,
      agentSessionId: typeof raw.sessionID === 'string' ? raw.sessionID : undefined,
    };
  },
  respond(decision, reasonCode, reason, hook) {
    if (hook.phase !== 'pre') return { stdout: '{}', exitCode: 0 };
    if (decision === 'allow') return { stdout: JSON.stringify({ decision: 'allow' }), exitCode: 0 };
    return { stdout: JSON.stringify({ decision: 'deny', reasonCode, reason: denyText(reasonCode, reason) }), exitCode: 0 };
  },
};
