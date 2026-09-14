import { canonicalTool } from '../tool-map.js';
import { denyText, type Adapter, type NormalizedHook } from './types.js';

export const geminiCli: Adapter = {
  id: 'gemini-cli',
  detect(raw) {
    return typeof raw.hook_event_name === 'string' && /^(BeforeTool|AfterTool|BeforeAgent|AfterAgent|SessionStart|SessionEnd|BeforeModel|AfterModel|BeforeToolSelection|PreCompress|Notification)$/.test(raw.hook_event_name);
  },
  normalize(raw): NormalizedHook {
    const event = String(raw.hook_event_name ?? '');
    const { tool, input } = canonicalTool(String(raw.tool_name ?? ''), raw.tool_input);
    const phase = event === 'BeforeTool' ? 'pre' : event === 'AfterTool' ? 'post' : 'other';
    return {
      phase,
      event,
      tool: phase === 'other' ? undefined : tool,
      input,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
      response: raw.tool_response ?? raw.tool_output ?? raw.tool_result,
      agentSessionId: typeof raw.session_id === 'string' ? raw.session_id : undefined,
    };
  },
  respond(decision, reasonCode, reason, hook) {
    if (hook.phase !== 'pre') return { stdout: '', exitCode: 0 };
    if (decision === 'allow') return { stdout: JSON.stringify({ decision: 'allow' }), exitCode: 0 };
    return { stdout: JSON.stringify({ decision: 'deny', reason: denyText(reasonCode, reason) }), exitCode: 0 };
  },
};
