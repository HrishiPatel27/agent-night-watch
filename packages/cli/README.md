# nightwatch-agent

A local overnight supervisor for coding agents: guarded runs in a disposable git worktree, deterministic
allow/deny/defer policies, a SQLite event log and a ranked morning report. Works with Claude Code, Codex
CLI, Gemini CLI, Copilot CLI, Cursor, Grok Build, OpenCode, Amp, Aider and custom agents on macOS, Linux
and Windows.

```bash
npm install -g nightwatch-agent
nightwatch init
nightwatch run --hours 8 --budget-usd 5 --task "Exercise the app, reproduce failures, and propose fixes"
nightwatch report latest --open
```

Requires Node.js 22.13+ and git. Full documentation:
https://github.com/HrishiPatel27/agent-night-watch#readme
