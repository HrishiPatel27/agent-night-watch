import fs from 'node:fs';
import YAML from 'yaml';
import { nightwatchPaths } from '@nightwatch-agent/shared';

export interface AgentOverride {
  /** Binary name/path override. */
  command?: string;
  /** Command template for custom agents: "{prompt}", "{worktree}", "{run_dir}" placeholders. */
  template?: string;
  model?: string;
  extra_args?: string[];
  /** For custom agents: how hooks are installed ("none" | "claude-settings-file"). */
  hooks?: 'none' | 'claude-settings-file';
  /** Enable the PATH shim guard for this agent. */
  shims?: boolean;
  /** Output format of the agent's stdout. */
  stream?: string;
}

export interface NightwatchConfig {
  agent: string;
  dashboard_port: number;
  dashboard: boolean;
  link_dependencies: string[];
  setup_command: string | null;
  test_command: string | null;
  open_report: boolean;
  shim_commands: string[];
  agents: Record<string, AgentOverride>;
  pricing: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }>;
  /** Use exec-form hooks ({command, args}) instead of a shell command string for Claude Code. */
  hooks_exec_form: boolean;
}

export const DEFAULT_SHIM_COMMANDS = [
  'git', 'rm', 'mv', 'cp', 'chmod', 'chown', 'dd', 'find', 'sed', 'tee', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'sudo', 'su', 'doas', 'kill', 'pkill', 'killall',
  'nohup', 'setsid', 'crontab', 'npm', 'npx', 'yarn', 'pnpm', 'bun', 'node', 'python', 'python3', 'pip', 'pip3', 'uv', 'poetry', 'cargo', 'go', 'make', 'docker', 'docker-compose', 'kubectl',
  'helm', 'terraform', 'aws', 'gcloud', 'az', 'vercel', 'netlify', 'fly', 'flyctl', 'heroku', 'gh', 'psql', 'mysql', 'mongosh', 'mongo', 'redis-cli', 'sqlcmd', 'brew', 'apt', 'apt-get', 'claude', 'codex', 'gemini', 'copilot', 'cursor-agent', 'agent', 'aider', 'amp', 'opencode', 'grok',
];

/** Approximate first-party list prices (USD per million tokens). Users can override in config.yaml. */
export const DEFAULT_PRICING: NightwatchConfig['pricing'] = {
  'claude-fable-5-1': { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  'claude-opus-5': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
};

export const DEFAULT_CONFIG: NightwatchConfig = {
  agent: 'claude-code',
  dashboard_port: 4782,
  dashboard: true,
  link_dependencies: ['node_modules', '.venv', 'venv', 'vendor', 'target', '.gradle', 'Pods'],
  setup_command: null,
  test_command: null,
  open_report: false,
  shim_commands: DEFAULT_SHIM_COMMANDS,
  agents: {},
  pricing: DEFAULT_PRICING,
  hooks_exec_form: false,
};

export function loadConfig(projectRoot: string): NightwatchConfig {
  const file = nightwatchPaths(projectRoot).config;
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  const doc = (YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  const cfg: NightwatchConfig = { ...DEFAULT_CONFIG, agents: {}, pricing: { ...DEFAULT_PRICING } };
  if (typeof doc.agent === 'string') cfg.agent = doc.agent;
  if (typeof doc.dashboard_port === 'number') cfg.dashboard_port = doc.dashboard_port;
  if (typeof doc.dashboard === 'boolean') cfg.dashboard = doc.dashboard;
  if (Array.isArray(doc.link_dependencies)) cfg.link_dependencies = doc.link_dependencies.filter((x): x is string => typeof x === 'string');
  if (typeof doc.setup_command === 'string' || doc.setup_command === null) cfg.setup_command = doc.setup_command ?? null;
  if (typeof doc.test_command === 'string') cfg.test_command = doc.test_command;
  if (typeof doc.open_report === 'boolean') cfg.open_report = doc.open_report;
  if (typeof doc.hooks_exec_form === 'boolean') cfg.hooks_exec_form = doc.hooks_exec_form;
  if (Array.isArray(doc.shim_commands)) cfg.shim_commands = doc.shim_commands.filter((x): x is string => typeof x === 'string');
  if (doc.agents && typeof doc.agents === 'object') cfg.agents = doc.agents as Record<string, AgentOverride>;
  if (doc.pricing && typeof doc.pricing === 'object') Object.assign(cfg.pricing, doc.pricing as NightwatchConfig['pricing']);
  return cfg;
}

export function defaultConfigYaml(agent: string, testCommand: string | null): string {
  return `# Nightwatch runtime configuration (policy lives in policy.yaml).
# Which agent "nightwatch run" launches by default:
#   claude-code | codex | gemini-cli | copilot-cli | cursor | grok | opencode | amp | aider | <custom name from agents:>
agent: ${agent}
# Loopback dashboard port (127.0.0.1 only). Set dashboard: false to disable.
dashboard_port: 4782
dashboard: true
# Dependency directories linked from the main tree into the run worktree (junctions on Windows).
link_dependencies: [node_modules, .venv, venv, vendor, target]
# Optional command run inside the worktree before the agent starts, e.g. "npm ci".
setup_command: null
# Test command used to detect and parse test runs in the report.
test_command: ${testCommand ? JSON.stringify(testCommand) : 'null'}
# Open the HTML report in a browser when a run finishes.
open_report: false
# Per-agent overrides. Custom agents need a command template.
agents:
  claude-code:
    model: null
    extra_args: []
  # my-agent:
  #   template: "my-agent --task {prompt} --dir {worktree}"
  #   hooks: none
  #   shims: true
`;
}

export function estimateCostUsd(pricing: NightwatchConfig['pricing'], model: string | null, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | null {
  if (!model) return null;
  const key = Object.keys(pricing).find((k) => model === k || model.startsWith(k) || model.includes(k));
  if (!key) return null;
  const p = pricing[key];
  const per = 1_000_000;
  return (tokens.input * p.input + tokens.output * p.output + tokens.cacheRead * (p.cache_read ?? p.input * 0.1) + tokens.cacheWrite * (p.cache_write ?? p.input * 1.25)) / per;
}
