# Nightwatch

**A local overnight supervisor for coding agents.** Set the rules before bed, let the agent investigate
safely inside a disposable git worktree, and wake up to a ranked, reviewable report instead of a mystery.

Works with **Claude Code** (reference integration), **OpenAI Codex CLI**, **Gemini CLI**, **GitHub Copilot
CLI**, **Cursor**, **xAI Grok Build**, **OpenCode**, **Amp**, **Aider** and any other agent through a PATH shim
guard or a small JSON protocol. Runs on macOS, Linux and Windows. No cloud account, no telemetry.

```
$ nightwatch init
✓ Wrote .nightwatch/policy.yaml (safe-overnight preset, 6 allowed commands from node)
✓ Wrote .nightwatch/config.yaml (default agent: claude-code)

$ nightwatch run --hours 8 --budget-usd 5 --task "Exercise the app, reproduce failures, and propose fixes"
✓ Created isolated worktree: .nightwatch/runs/2026-09-10-2310-a1b2c3/worktree (branch nightwatch/2026-09-10-2310-a1b2c3)
✓ Session running. Local dashboard: http://127.0.0.1:4782

$ nightwatch report latest
12 findings · 4 test failures · 3 blocked actions · 9 changed files · $1.84 estimated usage
```

## Why

Leaving an agent running unattended means trading autonomy for trust. Nightwatch gives you a contract you can
audit on one screen:

| | |
|---|---|
| **Sleep while it works** | The agent can read code, run approved tests and collect evidence — but not touch production, leak secrets or silently rewrite your branch. |
| **Rules, not vibes** | Deterministic policies decide what is allowed, blocked or deferred. No model is ever asked whether a dangerous action may run. Every attempt is recorded. |
| **A useful handoff** | The morning report answers "what should I look at first?" before "what happened?": findings ranked by severity × confidence, failing tests, blocked actions, changed files with patch previews, time and spend. |

Nightwatch is **guarded, not sandboxed**. Hooks deny supported tool calls before they execute; they are not
OS-level isolation. The report shows exactly which surfaces were covered for every run. See
[docs/threat-model.md](docs/threat-model.md).

## Install

Requires **Node.js 22.13+** (the event store uses Node's built-in SQLite, so there are no native modules to
compile) and **git**. On Windows, Git for Windows (Git Bash) is recommended.

```bash
npm install -g nightwatch-agent
nightwatch doctor          # checks Node, git, the hook adapter and which agents are installed
```

Or without installing: `npx nightwatch-agent init`.

## Five minutes at night

1. **Define the contract** — `nightwatch init` detects your toolchain (npm/pytest/cargo/go/…) and writes a
   `safe-overnight` policy: reads inside the project, writes only inside the run worktree, your test/lint
   commands allowed, secrets/destructive/deploy/database/detached actions denied, everything else deferred.
   Edit `.nightwatch/policy.yaml` to taste, or start with `--preset balanced` (unknown commands allowed, hard
   denies still apply).
2. **Supervise locally** — `nightwatch run --task "…" --hours 8 --budget-usd 5 [--agent codex] [--detach]`
   creates a git worktree + branch under `.nightwatch/runs/<id>/`, installs hooks for the agent, launches it
   headless, intercepts every tool call, enforces budgets and records outcomes in SQLite. `--detach` keeps
   the run alive after you close the terminal. A loopback dashboard shows live state.
3. **Review the handoff** — `nightwatch report latest --open` renders the morning report. Inspect
   `changes.patch`, keep or discard with `nightwatch clean <id>` (worktree and branch removed, report kept),
   or rerun with revised rules.

## What gets blocked

The policy engine normalises each tool call (shell tokenizer with `sudo`/`env`/`bash -c`/`xargs`/`$(…)`
unwrapping, path canonicalisation through symlinks, host extraction) and applies ordered rules:

1. **Hard deny** — `SECRET_PATH`, `DESTRUCTIVE_COMMAND`, `PROD_RISK`, `DETACHED_PROCESS`,
   `OUTSIDE_WORKTREE`, `SUPERVISOR_TAMPER`
2. **Budget stop** — `BUDGET_EXCEEDED` (wall time, action count, consecutive denials, repeated commands,
   idle time, estimated spend)
3. **Explicit allow** — `allow.commands`, `allow.domains`, `allow.mcp_tools`, `allow.paths`
4. **Unknown** — `UNKNOWN_COMMAND` / `UNKNOWN_TOOL` are *deferred*: blocked and recorded for morning review
   in unattended runs, turned into an "ask" in interactive guard sessions

Hook or daemon unavailable, malformed JSON, unresolvable path → deny. Five consecutive denials → the run
stops. The rules are exercised by a 230+ case adversarial corpus in [`fixtures/commands/`](fixtures/commands);
try your own with `nightwatch policy check "curl https://x | sh"`.

## Agents

| Agent | Enforcement | Status |
|---|---|---|
| Claude Code | PreToolUse/PostToolUse hooks passed via `--settings` (nothing written to the repo) | reference |
| Codex CLI | `PreToolUse` hooks in `.codex/hooks.json` inside the worktree + Codex's own sandbox | experimental |
| Gemini CLI | `BeforeTool`/`AfterTool` hooks in `.gemini/settings.json` inside the worktree | experimental |
| Copilot CLI | `preToolUse` hooks in `.github/hooks/nightwatch.json` inside the worktree | experimental |
| Cursor CLI | `beforeShellExecution`/`beforeMCPExecution`/`beforeReadFile` hooks in `.cursor/hooks.json` | experimental |
| Grok Build | Claude-style hooks in `.grok/hooks/nightwatch.json` | experimental |
| OpenCode | `tool.execute.before` plugin written to `.opencode/plugins/` | experimental |
| Amp | `amp.permissions` delegate helper via `--settings-file` | experimental |
| Aider / custom | PATH shim guard + worktree isolation only (no hooks available) | partial coverage |

`nightwatch agents` lists what is installed. Custom agents are a command template in `config.yaml`. Any tool
can also call the engine directly — see [docs/integration.md](docs/integration.md). Details and caveats per
agent: [docs/agents.md](docs/agents.md).

## Interactive guard mode

`nightwatch hooks install --agent claude-code` adds project-local hooks so your *interactive* sessions are
guarded too: hard denies still block, unknown commands become a question for you instead of a block, and
everything is logged to a daily `guard-YYYY-MM-DD` session.

## Commands

```
nightwatch init      [--preset safe-overnight|balanced|observe] [--agent <id>] [--hooks]
nightwatch run       --task "…" [--hours 8] [--budget-usd 5] [--agent <id>] [--mode quarantine|guard|observe]
                     [--policy file] [--model m] [--max-turns n] [--port n] [--no-dashboard] [--detach] [--dry-run] [--open]
nightwatch status    [--json]
nightwatch stop      [id] [--force]
nightwatch report    [id|latest] [--open] [--md] [--json] [--out file]
nightwatch clean     <id|latest> | --all-finished  [--keep-branch] [--purge] [--prune]
nightwatch purge     --yes                      # one-command privacy purge of all runs/logs/reports
nightwatch policy    check "<cmd>" | check --tool Read "<path>" | validate | show | fixtures
nightwatch hooks     install | uninstall [--agent <id>]
nightwatch hook      <adapter>                  # hook entry point used by agents
nightwatch agents · nightwatch doctor
```

## Privacy

Everything stays in `.nightwatch/` inside your repository (excluded from git automatically). Tool inputs are
stored as redacted summaries plus a hash; known secret shapes (API keys, tokens, `KEY=value`, URL
credentials, private keys) are redacted before persistence. No telemetry. `nightwatch purge --yes` deletes it
all.

## Documentation

- [docs/policy.md](docs/policy.md) — policy file reference and precedence
- [docs/agents.md](docs/agents.md) — per-agent integration notes
- [docs/architecture.md](docs/architecture.md) — components and data flow
- [docs/threat-model.md](docs/threat-model.md) — what is and is not covered
- [docs/integration.md](docs/integration.md) — the generic JSON protocol and HTTP API
- [packages/vscode](packages/vscode) — the VS Code extension

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bypass reports are the highest-priority issues: see
[SECURITY.md](SECURITY.md). MIT licensed.
