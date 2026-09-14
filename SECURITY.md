# Security policy

Nightwatch exists to make unattended agent runs safer, so bypasses are treated as the highest-severity bugs.

## What counts as a security issue

- A tool call that the default `safe-overnight` policy should deny is allowed.
- Supervision silently stops (hook or daemon failure that does not produce a blocked action and a visible run failure).
- A secret that should have been redacted reaches the SQLite store, a report, or a log file.
- The run worktree can modify the user's main working tree.

## Reporting

Open a private security advisory on GitHub ("Report a vulnerability") or, if that is unavailable, open an
issue using the *Policy bypass* template with secrets redacted. Please include the agent, the tool call and
the recorded decision. We aim to acknowledge within 72 hours.

## Scope and honesty

Nightwatch is **guarded, not sandboxed**. The threat model in `docs/threat-model.md` lists what hooks cannot
cover (already-running processes, network traffic from allowed commands, secrets in ordinary files, OS-level
isolation). Reports about those limits are welcome as feature requests, not vulnerabilities.
