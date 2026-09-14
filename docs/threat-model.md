# Threat model

Nightwatch reduces the risk of unattended agent runs. It does not eliminate it, and it must never claim to.

| Threat | Mitigation | Residual risk |
|---|---|---|
| Destructive shell command | Tokenise and unwrap; deny known patterns; unknown/unparsable → deny | Shell obfuscation is an arms race; the corpus in `fixtures/commands/` is the regression suite — add to it |
| Writes to the active project | Dedicated worktree; canonical path (symlinks resolved) must be inside it; main tree fingerprinted before/after | Processes that were already running, or tools the hook does not see, can still write |
| Credential access | Secret path globs on canonical *and* raw paths; env dumps and `$SECRET` expansions denied; values redacted before persistence | Secrets embedded in ordinary files (e.g. hard-coded in source) are readable; redaction is pattern-based |
| Production or deployment action | Deploy/publish/push/database/cloud CLIs denied; production-like connection strings denied; unknown network destinations denied | Custom scripts hide side effects; an allowed `npm test` may do anything its code does |
| Runaway cost or loop | Wall-time, action, consecutive-denial, repeated-command, idle and spend limits; `--max-budget-usd` passed to agents that support it | Spend is estimated from token usage when the agent does not report cost |
| Detached child process | `&`, `nohup`, `setsid`, multiplexers, service managers, `docker -d`, `run_in_background` denied | Already-running daemons are invisible; allowed commands may spawn what they like |
| Supervisor tampering | `.nightwatch/`, hook files, `NIGHTWATCH_*` variables, `git worktree`, branch switching, nested agents denied | A repo-level settings file with `disableAllHooks` is neutralised for Claude, but other agents' config precedence is theirs |
| Sensitive data in logs | Summaries + hashes, redaction, local-only storage, `purge` | Redaction is imperfect |
| Agent without hooks | PATH shims judge each spawned command; worktree isolation | Absolute paths, builtins and unlisted interpreters bypass shims |

## Not covered

- OS-level isolation. Nightwatch is not a container, VM or seccomp profile. Use disposable credentials and
  test databases.
- Network traffic from commands you allowed.
- Anything the agent does through a tool the adapter does not model (`UNKNOWN_TOOL` is deferred, but a
  vendor could add a side-effecting tool under a known name).
- Proof of absence: the event log is evidence of what the hook saw, not a guarantee that nothing else happened.

## Launch conditions we hold ourselves to

- Zero silent bypass: a hook or daemon failure produces a blocked action and a visible run failure.
- Known-risk fixtures are denied deterministically on every CI platform.
- Reports name the covered and uncovered surfaces for every run.
