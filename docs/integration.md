# Integrating any agent or IDE

Two ways to ask Nightwatch whether an action may run.

## 1. The generic hook protocol (stdin/stdout)

```
echo '{"tool":"Bash","input":{"command":"rm -rf /"},"cwd":"/path/to/worktree","phase":"pre"}' | nightwatch hook generic
{"decision":"deny","reasonCode":"DESTRUCTIVE_COMMAND","reason":"[Nightwatch DESTRUCTIVE_COMMAND] …"}
```

- `tool` — canonical name (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`,
  `mcp__server__tool`, …) or any vendor name; common aliases (`run_shell_command`, `view`, `create`,
  `edit_file`, `web_fetch`, …) and argument keys (`cmd`, `path`, `file_text`, `url`, …) are normalised.
- `phase` — `pre` (decision requested) or `post` (record a result; include `response`).
- `tool_use_id` — optional, pairs pre and post events.
- The session is found through `NIGHTWATCH_SESSION_ID` + `NIGHTWATCH_DB` (set by `nightwatch run`), or the
  nearest `.nightwatch/` directory (an attended guard session). Without either, the call is not supervised and
  returns `allow` with an empty stdout.
- `nightwatch hook amp` is the same protocol with exit codes: 0 allow, 1 ask/defer, 2 deny.

Decisions: `allow`, `deny`, `defer` (unattended runs never return `defer`; it becomes `deny` with the
reason "deferred for morning review").

## 2. The loopback HTTP API (during a run)

The dashboard server listens on `127.0.0.1:<port>` (default 4782). Mutating endpoints require the
`X-Nightwatch-Token` header; the token is in `.nightwatch/runs/<id>/dashboard.token`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | live HTML report |
| GET | `/api/status` | session row, action counts, decisions |
| GET | `/api/events?after=<seq>` | events since `seq` |
| GET | `/api/report.json` | full report model |
| GET | `/api/sessions` | recent sessions |
| POST | `/api/stop` | request a stop (token) |
| POST | `/api/evaluate` | `{tool, input, cwd}` → decision, using the active run's policy (token) |

## Writing an adapter

If your agent has a hook mechanism with its own payload shape, add an adapter in
`packages/hook/src/adapters/` implementing `detect`, `normalize` (map to `{phase, tool, input, cwd,
tool_use_id, response}`) and `respond` (produce the agent's native decision document). Add a payload sample to
`fixtures/hooks/` and a launch profile in `packages/daemon/src/agents.ts`. See `CONTRIBUTING.md`.
