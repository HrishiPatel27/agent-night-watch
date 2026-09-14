import type { StreamFormat } from './agents.js';

export type StreamEvent =
  | { kind: 'init'; model?: string; sessionId?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; name: string; input?: unknown }
  | { kind: 'usage'; input: number; output: number; cacheRead: number; cacheWrite: number; model?: string; costUsd?: number }
  | { kind: 'result'; costUsd?: number; turns?: number; isError?: boolean; text?: string }
  | { kind: 'error'; message: string }
  | { kind: 'raw' };

type J = Record<string, unknown>;
const obj = (v: unknown): J | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

type UsageEvent = Extract<StreamEvent, { kind: 'usage' }>;

function usageFrom(u: J | null, model?: string): UsageEvent | null {
  if (!u) return null;
  const input = num(u.input_tokens ?? u.prompt_tokens ?? u.input);
  const output = num(u.output_tokens ?? u.completion_tokens ?? u.output);
  if (!input && !output) return null;
  const cache = obj(u.cache);
  return {
    kind: 'usage',
    input,
    output,
    cacheRead: num(u.cache_read_input_tokens ?? u.cached_input_tokens ?? u.cache_read_tokens ?? cache?.read),
    cacheWrite: num(u.cache_creation_input_tokens ?? u.cache_write_input_tokens ?? u.cache_write_tokens ?? cache?.write),
    model,
    costUsd: typeof u.cost === 'number' ? u.cost : undefined,
  };
}

/** Parse one line of agent stdout into zero or more normalised events. Never throws. */
export function parseStreamLine(format: StreamFormat, line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (format === 'text') return [{ kind: 'text', text: trimmed }];
  let j: J;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const o = obj(parsed);
    if (!o) return [{ kind: 'raw' }];
    j = o;
  } catch {
    return [{ kind: 'text', text: trimmed }];
  }
  try {
    switch (format) {
      case 'claude-stream-json':
      case 'cursor-stream-json':
        return parseClaudeLike(j);
      case 'codex-jsonl':
        return parseCodex(j);
      case 'gemini-stream-json':
        return parseGemini(j);
      case 'opencode-json':
        return parseOpenCode(j);
      default:
        return parseGeneric(j);
    }
  } catch {
    return [{ kind: 'raw' }];
  }
}

function parseClaudeLike(j: J): StreamEvent[] {
  const out: StreamEvent[] = [];
  const type = String(j.type ?? '');
  if (type === 'system' && j.subtype === 'init') {
    out.push({ kind: 'init', model: typeof j.model === 'string' ? j.model : undefined, sessionId: typeof j.session_id === 'string' ? j.session_id : undefined });
  } else if (type === 'assistant') {
    const msg = obj(j.message);
    const model = typeof msg?.model === 'string' ? msg.model : undefined;
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const block of content) {
      const b = obj(block);
      if (!b) continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ kind: 'text', text: b.text });
      if (b.type === 'tool_use') out.push({ kind: 'tool_use', name: String(b.name ?? 'tool'), input: b.input });
    }
    const usage = usageFrom(obj(msg?.usage), model);
    if (usage) out.push(usage);
  } else if (type === 'tool_call') {
    const tc = obj(j.tool_call);
    if (j.subtype === 'started') out.push({ kind: 'tool_use', name: String(tc?.name ?? Object.keys(tc ?? {})[0] ?? 'tool'), input: tc });
  } else if (type === 'result') {
    out.push({
      kind: 'result',
      costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined,
      turns: typeof j.num_turns === 'number' ? j.num_turns : undefined,
      isError: j.is_error === true || (typeof j.subtype === 'string' && j.subtype.startsWith('error')),
      text: typeof j.result === 'string' ? j.result : undefined,
    });
    const usage = usageFrom(obj(j.usage));
    if (usage && !out.some((e) => e.kind === 'usage')) {
      // The final result repeats totals already accumulated from assistant messages; keep it only as a fallback.
      out.push({ ...usage, kind: 'usage', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  } else if (type === 'error') {
    out.push({ kind: 'error', message: String(j.message ?? j.error ?? 'error') });
  } else if (type === 'text' && typeof j.text === 'string') {
    out.push({ kind: 'text', text: j.text });
  } else if (type === 'usage') {
    const u = usageFrom(j);
    if (u) out.push(u);
  } else if (type === 'end') {
    out.push({ kind: 'result', costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined });
  }
  return out.length ? out : [{ kind: 'raw' }];
}

function parseCodex(j: J): StreamEvent[] {
  const type = String(j.type ?? '');
  if (type === 'thread.started') return [{ kind: 'init', sessionId: typeof j.thread_id === 'string' ? j.thread_id : undefined }];
  if (type === 'item.completed') {
    const item = obj(j.item);
    if (!item) return [{ kind: 'raw' }];
    if (item.type === 'agent_message' && typeof item.text === 'string') return [{ kind: 'text', text: item.text }];
    if (item.type === 'command_execution') return [{ kind: 'tool_use', name: 'Bash', input: { command: item.command } }];
    if (item.type === 'file_change') return [{ kind: 'tool_use', name: 'Edit', input: { changes: item.changes } }];
    if (item.type === 'mcp_tool_call') return [{ kind: 'tool_use', name: `mcp__${String(item.server)}__${String(item.tool)}`, input: item.arguments }];
    if (item.type === 'error') return [{ kind: 'error', message: String(item.message ?? 'error') }];
    return [{ kind: 'raw' }];
  }
  if (type === 'turn.completed') {
    const u = usageFrom(obj(j.usage));
    return u ? [u] : [{ kind: 'raw' }];
  }
  if (type === 'turn.failed' || type === 'error') return [{ kind: 'error', message: String(obj(j.error)?.message ?? j.message ?? 'turn failed') }];
  return [{ kind: 'raw' }];
}

function parseGemini(j: J): StreamEvent[] {
  const type = String(j.type ?? '');
  if (type === 'init') return [{ kind: 'init', model: typeof j.model === 'string' ? j.model : undefined, sessionId: typeof j.session_id === 'string' ? j.session_id : undefined }];
  if (type === 'message') {
    const role = j.role ?? obj(j.message)?.role;
    const content = j.content ?? obj(j.message)?.content;
    if (role === 'assistant' && typeof content === 'string' && content.trim()) return [{ kind: 'text', text: content }];
    return [{ kind: 'raw' }];
  }
  if (type === 'tool_use') return [{ kind: 'tool_use', name: String(j.tool_name ?? j.name ?? 'tool'), input: j.parameters ?? j.input }];
  if (type === 'error') return [{ kind: 'error', message: String(j.message ?? 'error') }];
  if (type === 'result') {
    const stats = obj(j.stats);
    const out: StreamEvent[] = [{ kind: 'result', isError: !!j.error, text: typeof j.response === 'string' ? j.response : undefined }];
    const models = obj(stats?.models);
    if (models) {
      for (const [model, v] of Object.entries(models)) {
        const tokens = obj(obj(v)?.tokens);
        const u = usageFrom(tokens ? { input_tokens: tokens.prompt ?? tokens.input, output_tokens: tokens.candidates ?? tokens.output, cache_read_tokens: tokens.cached } : null, model);
        if (u) out.push(u);
      }
    }
    return out;
  }
  return [{ kind: 'raw' }];
}

function parseOpenCode(j: J): StreamEvent[] {
  const type = String(j.type ?? '');
  const part = obj(j.part) ?? j;
  if (type === 'text' && typeof part.text === 'string') return [{ kind: 'text', text: part.text }];
  if (type === 'tool_use') return [{ kind: 'tool_use', name: String(part.tool ?? 'tool'), input: obj(part.state)?.input }];
  if (type === 'step_finish') {
    const u = usageFrom(obj(part.tokens));
    if (u) {
      u.costUsd = typeof part.cost === 'number' ? part.cost : u.costUsd;
      return [u];
    }
    return [{ kind: 'raw' }];
  }
  if (type === 'error') return [{ kind: 'error', message: String(obj(part.error)?.message ?? part.message ?? 'error') }];
  return [{ kind: 'raw' }];
}

function parseGeneric(j: J): StreamEvent[] {
  const out: StreamEvent[] = [];
  const u = usageFrom(obj(j.usage) ?? (j.input_tokens != null ? j : null), typeof j.model === 'string' ? j.model : undefined);
  if (u) out.push(u);
  const text = j.text ?? j.content ?? obj(j.message)?.content;
  if (typeof text === 'string' && text.trim() && (j.role === 'assistant' || j.type === 'assistant' || j.type === 'text' || j.type === 'message' || !j.role)) out.push({ kind: 'text', text });
  if (typeof j.total_cost_usd === 'number') out.push({ kind: 'result', costUsd: j.total_cost_usd });
  if (j.type === 'error' || j.error) out.push({ kind: 'error', message: String(j.message ?? obj(j.error)?.message ?? j.error ?? 'error') });
  return out.length ? out : [{ kind: 'raw' }];
}
