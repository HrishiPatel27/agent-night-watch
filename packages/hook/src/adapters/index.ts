import { claudeCode, codex, detectCodex, grok } from './claude-code.js';
import { cursor } from './cursor.js';
import { geminiCli } from './gemini.js';
import { copilotCli } from './copilot.js';
import { opencode } from './opencode.js';
import { amp, generic } from './generic.js';
import type { Adapter, J } from './types.js';

export const ADAPTERS: Record<string, Adapter> = {
  'claude-code': claudeCode,
  claude: claudeCode,
  codex,
  grok,
  cursor,
  'gemini-cli': geminiCli,
  gemini: geminiCli,
  'copilot-cli': copilotCli,
  copilot: copilotCli,
  opencode,
  amp,
  generic,
};

/** Pick an adapter by name, or sniff the payload when "auto". Order matters: specific shapes first. */
export function selectAdapter(name: string | undefined, raw: J): Adapter {
  if (name && name !== 'auto') {
    const a = ADAPTERS[name];
    if (!a) throw new Error(`unknown hook adapter "${name}" (known: ${Object.keys(ADAPTERS).join(', ')})`);
    return a;
  }
  if (cursor.detect(raw)) return cursor;
  if (opencode.detect(raw)) return opencode;
  if (geminiCli.detect(raw)) return geminiCli;
  if (copilotCli.detect(raw)) return copilotCli;
  if (detectCodex(raw)) return codex;
  if (claudeCode.detect(raw)) return claudeCode;
  if (generic.detect(raw)) return generic;
  return claudeCode;
}

export * from './types.js';
