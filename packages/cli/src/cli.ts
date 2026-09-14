import { parseArgs } from 'node:util';
import { VERSION } from '@nightwatch-agent/shared';
import { cmdAgents, cmdClean, cmdDoctor, cmdHook, cmdHooks, cmdInit, cmdPolicy, cmdPurge, cmdReport, cmdRun, cmdStatus, cmdStop, type Flags } from './commands.js';
import { CliError, out } from './util.js';

const HELP = `nightwatch ${VERSION} — a local overnight supervisor for coding agents

Usage: nightwatch <command> [options]

Commands
  init        Create .nightwatch/policy.yaml + config.yaml for this repository
                --preset safe-overnight|balanced|observe  --agent <id>  --hooks  --force
  run         Start a guarded run in a disposable git worktree
                --task "<objective>"  --hours 8  --budget-usd 5  --agent <id>  --mode quarantine|guard|observe
                --policy <file>  --model <m>  --max-turns <n>  --port <n>  --no-dashboard  --detach  --dry-run  --open
  status      List runs and their state (--json)
  stop        Stop the active run (nightwatch stop [id] [--force])
  report      Render the morning report (nightwatch report [id|latest] [--open] [--md] [--json] [--out <file>])
  clean       Remove a run's worktree and branch (nightwatch clean <id|latest> | --all-finished  [--keep-branch] [--purge] [--prune])
  purge       Delete every recorded run, event and report (--yes)
  policy      check "<command>" | check --tool Read "<path>" | validate [file] | show | fixtures [dir]
  hooks       install | uninstall  project-local hooks for interactive guard mode (--agent <id>)
  hook        Hook entry point for agents: nightwatch hook <claude-code|codex|gemini-cli|copilot-cli|cursor|grok|opencode|amp|generic|auto>
  agents      List supported agents and whether they are installed
  doctor      Check the local environment
Global options: --project <dir>  --help  --version

Agents: claude-code (reference integration), codex, gemini-cli, copilot-cli, cursor, grok, opencode, amp, aider (shims only), or a custom template in config.yaml.
Docs: https://github.com/HrishiPatel27/agent-night-watch#readme`;

const STRING_FLAGS = ['project', 'preset', 'agent', 'task', 'hours', 'budget-usd', 'mode', 'policy', 'model', 'max-turns', 'port', 'limit', 'out', 'tool', 'input', 'worktree', 'cwd'];
const BOOL_FLAGS = ['help', 'version', 'hooks', 'force', 'no-dashboard', 'detach', '_child', 'dry-run', 'open', 'json', 'md', 'keep-branch', 'purge', 'prune', 'all-finished', 'yes', 'attended'];

export async function main(argv: string[]): Promise<void> {
  let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] };
  try {
    const options: Record<string, { type: 'string' | 'boolean'; short?: string }> = {};
    for (const f of STRING_FLAGS) options[f] = { type: 'string' };
    for (const f of BOOL_FLAGS) options[f] = { type: 'boolean' };
    options.help.short = 'h';
    options.version.short = 'v';
    options.detach.short = 'd';
    options.task.short = 't';
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new CliError(`${(err as Error).message}\n\n${HELP}`);
  }
  const flags = parsed.values as Flags;
  const [command, ...rest] = parsed.positionals;
  if (flags.version) {
    out.info(VERSION);
    return;
  }
  if (flags.help || !command) {
    out.info(HELP);
    return;
  }
  switch (command) {
    case 'init':
      return cmdInit(flags);
    case 'run':
      return cmdRun(flags, rest);
    case 'status':
    case 'ls':
      return cmdStatus(flags);
    case 'stop':
      return cmdStop(flags, rest);
    case 'report':
      return cmdReport(flags, rest);
    case 'clean':
      return cmdClean(flags, rest);
    case 'purge':
      return cmdPurge(flags);
    case 'policy':
      return cmdPolicy(flags, rest);
    case 'hooks':
      return cmdHooks(flags, rest);
    case 'hook':
      return cmdHook(rest);
    case 'agents':
      return cmdAgents(flags);
    case 'doctor':
      return cmdDoctor(flags);
    default:
      throw new CliError(`unknown command "${command}"\n\n${HELP}`);
  }
}

export { HELP };
