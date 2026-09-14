import { canonicalTool } from '../tool-map.js';
import { denyText, type Adapter, type NormalizedHook } from './types.js';

const PRE_EVENTS: Record<string, string> = { beforeShellExecution: 'Bash', beforeMCPExecution: 'mcp', beforeReadFile: 'Read', preToolUse: 'tool' };
const POST_EVENTS = new Set(['afterShellExecution', 'afterMCPExecution', 'afterFileEdit', 'postToolUse', 'postToolUseFailure']);

export const cursor: Adapter = {
  id: 'cursor',
  detect(raw) {
    return typeof raw.conversation_id === 'string' || (typeof raw.hook_event_name === 'string' && /^(before|after)[A-Z]/.test(raw.hook_event_name));
  },
  normalize(raw): NormalizedHook {
    const event = String(raw.hook_event_name ?? '');
    const roots = Array.isArray(raw.workspace_roots) ? (raw.workspace_roots as string[]) : [];
    const cwd = typeof raw.cwd === 'string' ? raw.cwd : roots[0];
    const base = { event, cwd, agentSessionId: typeof raw.conversation_id === 'string' ? raw.conversation_id : undefined, toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : undefined };
    if (event in PRE_EVENTS) {
      const kind = PRE_EVENTS[event];
      if (kind === 'Bash') return { ...base, phase: 'pre', tool: 'Bash', input: { command: String(raw.command ?? '') } };
      if (kind === 'Read') return { ...base, phase: 'pre', tool: 'Read', input: { file_path: String(raw.file_path ?? '') } };
      if (kind === 'mcp') {
        const server = String(raw.mcp_server_name ?? 'server').replace(/[^A-Za-z0-9_-]/g, '_');
        return { ...base, phase: 'pre', tool: `mcp__${server}__${String(raw.tool_name ?? 'tool')}`, input: (raw.tool_input as Record<string, unknown>) ?? {} };
      }
      const { tool, input } = canonicalTool(String(raw.tool_name ?? ''), raw.tool_input);
      return { ...base, phase: 'pre', tool, input };
    }
    if (POST_EVENTS.has(event)) {
      const toolName = event === 'afterShellExecution' ? 'Bash' : event === 'afterFileEdit' ? 'Edit' : event === 'afterMCPExecution' ? `mcp__${String(raw.mcp_server_name ?? 'server')}__${String(raw.tool_name ?? 'tool')}` : String(raw.tool_name ?? '');
      const { tool, input } = canonicalTool(toolName, raw.tool_input ?? { command: raw.command, file_path: raw.file_path, edits: raw.edits });
      return { ...base, phase: 'post', tool, input, response: raw.output ?? raw.result ?? raw.tool_output ?? raw.tool_response };
    }
    return { ...base, phase: 'other' };
  },
  respond(decision, reasonCode, reason, hook) {
    if (hook.phase !== 'pre') return { stdout: hook.event === 'beforeSubmitPrompt' ? JSON.stringify({ continue: true }) : '{}', exitCode: 0 };
    if (decision === 'allow') return { stdout: JSON.stringify({ permission: 'allow' }), exitCode: 0 };
    const text = denyText(reasonCode, reason);
    const permission = decision === 'defer' && hook.event !== 'beforeReadFile' ? 'ask' : 'deny';
    return { stdout: JSON.stringify({ permission, user_message: text, agent_message: text }), exitCode: 0 };
  },
};
