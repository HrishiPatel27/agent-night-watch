import { canonicalTool } from '../tool-map.js';
import { ALLOW, denyText, type Adapter, type J, type NormalizedHook } from './types.js';

/**
 * Claude Code hooks. Also used (with tool-name mapping) by Codex and Grok
 * Build, whose hook payloads follow the same shape.
 */
export function claudeStyleAdapter(id: string, options: { supportsAsk: boolean }): Adapter {
  return {
    id,
    detect(raw) {
      const ev = raw.hook_event_name ?? raw.hookEventName;
      return typeof ev === 'string' && (raw.tool_input !== undefined || raw.toolInput !== undefined || /^(Stop|SessionEnd|SessionStart|SubagentStop|UserPromptSubmit|PreCompact|Notification)$/.test(ev));
    },
    normalize(raw): NormalizedHook {
      const event = String(raw.hook_event_name ?? raw.hookEventName ?? '');
      const rawTool = String(raw.tool_name ?? raw.toolName ?? '');
      const { tool, input } = canonicalTool(rawTool, raw.tool_input ?? raw.toolInput);
      const phase = event === 'PreToolUse' ? 'pre' : event === 'PostToolUse' ? 'post' : 'other';
      return {
        phase,
        event,
        tool: phase === 'other' ? undefined : tool,
        input,
        toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : typeof raw.toolUseId === 'string' ? raw.toolUseId : undefined,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot : undefined,
        response: raw.tool_response ?? raw.tool_output ?? raw.toolResponse ?? raw.toolOutput ?? raw.tool_result,
        agentSessionId: typeof raw.session_id === 'string' ? raw.session_id : typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
      };
    },
    respond(decision, reasonCode, reason, hook) {
      if (hook.phase !== 'pre') return ALLOW;
      if (decision === 'allow') return ALLOW; // silence keeps the agent's own permission flow intact
      const permissionDecision = decision === 'defer' && options.supportsAsk ? 'ask' : 'deny';
      const text = denyText(reasonCode, reason);
      return {
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: text } }),
        exitCode: 0,
      };
    },
  };
}

export const claudeCode = claudeStyleAdapter('claude-code', { supportsAsk: true });
export const codex = claudeStyleAdapter('codex', { supportsAsk: false });
export const grok = claudeStyleAdapter('grok', { supportsAsk: true });

export function detectCodex(raw: J): boolean {
  return typeof raw.turn_id === 'string' && typeof raw.hook_event_name === 'string';
}
