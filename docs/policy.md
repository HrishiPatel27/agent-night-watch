# Policy reference

The policy lives in `.nightwatch/policy.yaml`. It is deterministic: the same call with the same policy
always produces the same decision, and no model is consulted.

```yaml
version: 1
name: safe-overnight
mode: quarantine            # observe | guard | quarantine
limits:
  wall_time_minutes: 480
  actions: 2000
  consecutive_denials: 5
  budget_usd: 5             # optional; also passed to agents that support a spend cap
  repeated_command: 25      # same command attempted N times in a row → stop
  idle_minutes: 30          # no tool calls for N minutes → stop
  failed_test_runs: 0       # stop after N failed test runs (0 = never)
allow:
  commands: ["npm test", "npm run lint", "git diff", "git status", "pytest *"]
  paths: ["${RUN_WORKTREE}/**"]          # writable roots
  read_paths: []                          # extra readable roots (project root is always readable)
  domains: ["localhost", "127.0.0.1", "*.internal.example.com"]
  mcp_tools: ["mcp__github__get_*"]
  tools: []                               # unknown non-MCP tools to allow
  builtin_safe_commands: true             # ls, cat, grep, git status, …
  web_search: false
deny:
  paths: ["**/.env*", "**/*secret*", "~/.ssh/**"]   # added to the built-in secret list
  commands: ["sudo *", "rm -rf *", "git push *", "* deploy *"]
  detached_processes: true
  unknown_mcp_tools: true
unknown_commands: defer      # defer | allow
test_command: npm test
redact_patterns: []          # extra regexes redacted before anything is stored
```

Variables: `${RUN_WORKTREE}`, `${PROJECT_ROOT}`, `${HOME}`, `~`.

## Modes

- **quarantine** (default for `run`) — the agent works in a disposable git worktree; writes are confined to it,
  reads to it plus the project root. Unattended: *defer* means deny.
- **guard** — interactive use in your own tree via `nightwatch hooks install`; writes confined to the project;
  *defer* becomes an "ask" where the agent supports it.
- **observe** — never blocks; records what *would* have happened (`OBSERVE_ONLY` with the shadow decision).

## Decision precedence

1. **Hard deny** (any of these wins, in this order): `SUPERVISOR_TAMPER`, `SECRET_PATH`,
   `DESTRUCTIVE_COMMAND`, `PROD_RISK`, `DETACHED_PROCESS`, `OUTSIDE_WORKTREE`, `PATH_UNRESOLVED`.
   Patterns you add in `deny.commands` are also hard denies but rank below the built-in classification, so the
   report shows the most specific reason.
2. **Budget stop** — `BUDGET_EXCEEDED` (wall time, actions, consecutive denials, repeated command, spend).
3. **Explicit allow** — `allow.commands` (every segment of a compound command must be allowed or
   built-in-safe), `allow.domains`, `allow.mcp_tools`, `allow.tools`. An explicit allow overrides the *soft*
   network class, never a hard deny.
4. **Unknown** — `UNKNOWN_COMMAND`, `UNKNOWN_TOOL`, unparsable shell → defer.

## Command patterns

`allow.commands` and `deny.commands` are wildcards, not globs: `*` matches anything including spaces, `?` one
character. A pattern without a trailing `*` also matches when the command *starts with* it followed by a space
(`git diff` covers `git diff --stat`). Patterns are matched against each simple command after wrappers such as
`sudo`, `env`, `nohup`, `xargs`, `bash -c` and `$(…)` have been unwrapped, and against the raw line.

## Built-in safe commands

With `builtin_safe_commands: true` (default) read-only coreutils (`ls`, `cat`, `grep`, `rg`, `find`, `jq`, …),
git read/in-worktree operations (`status`, `diff`, `log`, `add`, `commit`, `stash`, `rebase`, …),
`--version`/`--help` invocations and toolchain introspection (`npm ls`, `go env`, `cargo metadata`, …) are
allowed **as long as their path arguments stay inside the readable/writable roots**. Commands that execute
project code (`npm test`, `pytest`, `make`, `node script.js`) are never built-in; put them in
`allow.commands`. `nightwatch init` seeds that list from your `package.json`, `pyproject.toml`, `Cargo.toml`,
`go.mod`, `Makefile`, etc.

## What the hard-deny classes contain

| Code | Examples |
|---|---|
| `SECRET_PATH` | `.env*`, `*secret*`, `~/.ssh`, `~/.aws`, `~/.kube`, `*.pem`, `*.key`, `.npmrc`, `.netrc`, `/etc/shadow`, `/proc/*/environ`; `env`/`printenv`/`set` dumps; `$API_KEY` expansions; credential CLIs (`gh auth token`, `op`, `vault`, `security find-*`) |
| `DESTRUCTIVE_COMMAND` | `sudo`/`su`/`doas`; `rm -rf`, `rm` of root-like paths, `find -delete`; `dd`/`mkfs`/`shred`; `kill`/`pkill`; `shutdown`; fork bombs; `curl … \| sh`; `git reset --hard`, `git clean`, `git branch -D`, history rewriting; `docker system prune`, privileged containers; PowerShell/cmd equivalents |
| `PROD_RISK` | `git push`/`git remote`; `npm publish`, `cargo publish`, `twine upload`; deploy CLIs (`vercel`, `fly`, `kubectl apply`, `terraform apply`, `aws`, `gcloud`, `az`, `gh release`, `gh pr merge`); database clients unless the host is loopback; production-like connection strings; destructive migrations; external tools such as `Artifact`/`PushNotification` |
| `DETACHED_PROCESS` | trailing `&`, `nohup`, `setsid`, `tmux`/`screen`, `pm2`, `crontab`, `systemctl start`, `docker run -d`, `open`/`xdg-open`, `run_in_background` |
| `OUTSIDE_WORKTREE` | writes outside the writable roots, reads outside the readable roots, `cd` elsewhere, system package managers, global installs, `git config --global` |
| `SUPERVISOR_TAMPER` | touching `.nightwatch/`, agent hook files (`.claude/settings*.json`, `.cursor/hooks.json`, …), `NIGHTWATCH_*` env vars, `git worktree`, branch switching, `core.hooksPath`, launching another coding agent |
| `NETWORK_NOT_ALLOWED` (soft) | `curl`/`wget`/`ssh`/`nc`/`git fetch`/`WebFetch` to hosts not in `allow.domains`; `/dev/tcp` |

## Checking a command

```
nightwatch policy check "rm -rf dist"
✗ DENY  DESTRUCTIVE_COMMAND  (destructive.rm_rf)
nightwatch policy check --tool Read ".env"
nightwatch policy check --policy other.yaml --attended "node scripts/x.js"    # defer instead of deny
nightwatch policy fixtures                                                    # run the corpus
```
