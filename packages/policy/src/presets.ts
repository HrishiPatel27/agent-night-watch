import type { Policy } from '@nightwatch-agent/shared';

export const DEFAULT_LIMITS: Policy['limits'] = {
  wall_time_minutes: 480,
  actions: 2000,
  consecutive_denials: 5,
  budget_usd: undefined,
  repeated_command: 25,
  idle_minutes: 30,
  failed_test_runs: 0,
};

export const DEFAULT_ALLOW: Policy['allow'] = {
  commands: [],
  paths: ['${RUN_WORKTREE}/**'],
  read_paths: [],
  domains: ['localhost', '127.0.0.1', '::1'],
  mcp_tools: [],
  tools: [],
  builtin_safe_commands: true,
  web_search: false,
};

export const DEFAULT_DENY: Policy['deny'] = {
  paths: ['**/.env*', '**/*secret*', '~/.ssh/**', '~/.aws/**', '~/.config/gcloud/**', '~/.kube/**'],
  commands: ['sudo *', 'rm -rf *', 'git push *', '* deploy *', 'npm publish*', 'curl * | sh', 'curl * | bash', 'wget * | sh'],
  detached_processes: true,
  unknown_mcp_tools: true,
};

/** The spec's "Safe overnight" preset: strict, default-deny, worktree-confined. */
export function safeOvernightPreset(extraAllow: string[] = [], testCommand?: string): Policy {
  return {
    version: 1,
    name: 'safe-overnight',
    mode: 'quarantine',
    limits: { ...DEFAULT_LIMITS },
    allow: {
      ...DEFAULT_ALLOW,
      commands: uniq(['git diff', 'git status', 'git log', ...extraAllow]),
    },
    deny: { ...DEFAULT_DENY, paths: [...DEFAULT_DENY.paths], commands: [...DEFAULT_DENY.commands] },
    unknown_commands: 'defer',
    test_command: testCommand,
    redact_patterns: [],
  };
}

/** Same hard denies, but unknown commands are allowed. Useful once the safe preset proves too strict. */
export function balancedPreset(extraAllow: string[] = [], testCommand?: string): Policy {
  const p = safeOvernightPreset(extraAllow, testCommand);
  p.name = 'balanced';
  p.unknown_commands = 'allow';
  return p;
}

/** Observe only: never blocks, records everything. */
export function observePreset(): Policy {
  const p = balancedPreset();
  p.name = 'observe';
  p.mode = 'observe';
  return p;
}

export const PRESETS: Record<string, (extraAllow?: string[], testCommand?: string) => Policy> = {
  'safe-overnight': safeOvernightPreset,
  balanced: balancedPreset,
  observe: observePreset,
};

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}
