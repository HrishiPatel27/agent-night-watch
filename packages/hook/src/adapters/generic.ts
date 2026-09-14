import { canonicalTool } from '../tool-map.js';
import { denyText, type Adapter, type NormalizedHook } from './types.js';

/**
 * Nightwatch's own integration protocol for any agent or IDE:
 *   stdin:  {"tool": "Bash", "input": {"command": "rm -rf /"}, "cwd": "/path", "phase": "pre"|"post", "tool_use_id": "…", "response": …}
 *   stdout: {"decision": "allow"|"deny"|"defer", "reasonCode": "…", "reason": "…"}
 * With `--exit-codes` the process exit status also encodes the decision (0 allow, 1 ask/defer, 2 deny), which is
 * what Amp's permission `delegate` helper expects.
 */
export function genericAdapter(id: string, exitCodes: boolean): Adapter {
  return {
    id,
    detect(raw) {
      return typeof raw.tool === 'string' && (raw.input !== undefined || raw.args !== undefined || raw.params !== undefined);
    },
    normalize(raw): NormalizedHook {
      const { tool, input } = canonicalTool(String(raw.tool ?? raw.tool_name ?? raw.name ?? ''), raw.input ?? raw.args ?? raw.params ?? raw);
      const phase = raw.phase === 'post' ? 'post' : raw.phase === 'other' ? 'other' : 'pre';
      return {
        phase,
        event: String(raw.phase ?? 'pre'),
        tool,
        input,
        toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : undefined,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        response: raw.response ?? raw.output ?? raw.result,
      };
    },
    respond(decision, reasonCode, reason, hook) {
      const body = JSON.stringify({ decision, reasonCode, reason: decision === 'allow' ? reason : denyText(reasonCode, reason) });
      if (hook.phase !== 'pre') return { stdout: body, exitCode: 0 };
      const exitCode = !exitCodes ? 0 : decision === 'allow' ? 0 : decision === 'defer' ? 1 : 2;
      return { stdout: body, stderr: decision === 'allow' ? undefined : denyText(reasonCode, reason), exitCode };
    },
  };
}

export const generic = genericAdapter('generic', false);
export const amp = genericAdapter('amp', true);
