# Architecture

```
agent process (claude / codex / gemini / …)
      │  tool call
      ├── pre-execution hook ──► nightwatch hook <adapter> ──► policy engine ──► allow / deny / ask
      │                                   │                          ▲
      ▼                                   ▼                          │ policy + budget state
  tool executes                     SQLite event log  ◄──────────────┘
      │                                   ▲
      └── post-execution hook ────────────┘  (result summary, test parsing)
                                          │
                                  nightwatch run (runner)
                          ┌───────────────┼──────────────┐
                          ▼               ▼              ▼
                    git worktree      watchdog        loopback dashboard
                    + branch          (budgets,       127.0.0.1:4782
                                      stop, idle)         │
                                                          ▼
                                                    morning report
```

## Packages

- **shared** — reason codes, types, redaction (`redactText`, `digest`, `summarizeToolInput`), path
  canonicalisation (`canonicalizePath` resolves every existing ancestor's symlinks so `worktree/link/x` cannot
  escape), project-root discovery.
- **policy** — `parseCommand` (POSIX tokenizer: quotes, operators, redirects, heredocs, substitutions, wrapper
  unwrapping, flagging constructs it does not understand), `catalog` (word lists), `engine.evaluate`
  (precedence, per-tool handling), presets, YAML loader, fixture runner.
- **daemon** — `NightwatchStore` (SQLite WAL, `BEGIN IMMEDIATE` for concurrent hooks), git helpers
  (worktrees, fingerprints, patch export), agent profiles and hook-file generation, PATH shims, budgets,
  stream parsers, preflight, the runner and the HTTP server.
- **hook** — adapters (`claude-code`, `codex`, `grok`, `cursor`, `gemini-cli`, `copilot-cli`, `opencode`,
  `amp`, `generic`), tool-name/argument normalisation, session lookup, shim entry, `bin.js`.
- **report** — report model (ranking, health, look-first), HTML, Markdown, terminal renderers.
- **cli** — the `nightwatch` command; wires the renderer into the runner and dashboard.
- **vscode** — thin client over the CLI.

## A run, step by step

1. **Preflight** — Node ≥ 22.13, git, repository with commits, agent binary, hook self-test, policy validity,
   storage writable, no live session, free loopback port. Interrupted sessions from earlier crashes are
   detected (dead pid) and marked.
2. **Isolation** — `git worktree add -b nightwatch/<id> .nightwatch/runs/<id>/worktree HEAD`; dependency
   directories (`node_modules`, `.venv`, …) are linked in; the main tree is fingerprinted (HEAD, index, diff,
   untracked set).
3. **Launch plan** — per-agent args, hook files (merged if the repo has its own), instructions appended to the
   prompt (findings file format, limits, no branch switching), environment (`NIGHTWATCH_SESSION_ID`,
   `NIGHTWATCH_DB`, optional shim `PATH`).
4. **Supervision** — each hook invocation opens the database, evaluates the call with live budget state,
   records one durable event (`seq` per session), and answers in the agent's format. The runner's watchdog
   checks stop conditions every 3 s and terminates the process tree when one fires. The agent's stdout stream
   is parsed for usage/cost and assistant text (redacted).
5. **Finalise** — hook files restored/removed, patch and change list exported (findings file excluded), main
   tree fingerprint compared, status set, report rendered to `report.html` + `report.json`.
6. **Morning** — `report`, `clean` (worktree + branch), `purge`.

## Event record

| field | purpose |
|---|---|
| `session_id`, `seq` | ordering and identity |
| `event`, `tool`, `tool_use_id` | hook event and canonical tool |
| `input_digest`, `input_summary` | hash + redacted summary; raw inputs are never stored |
| `decision`, `reason_code`, `reason_text`, `rule` | policy outcome |
| `result_summary`, `result_ok`, `duration_ms` | post-execution outcome |
| `created_at` | UTC timestamp |

## Fail-closed rules

Hook payload unparsable → deny (`MALFORMED_INPUT`, exit 2). Session missing or not running → deny
(`SESSION_INACTIVE`). Path cannot be canonicalised → deny (`PATH_UNRESOLVED`). Shell construct not modelled
(process substitution, unterminated quotes, function definitions) → unknown → deny when unattended. Engine
exception → deny. The runner never switches from guarded to unguarded execution: a supervision failure stops
the run with an explanation.
