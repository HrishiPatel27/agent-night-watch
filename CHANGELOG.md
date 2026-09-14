# Changelog

## 0.1.0 (unreleased)

First public MVP.

- Deterministic policy engine with ordered precedence (hard deny → budget → explicit allow → unknown/defer),
  shell tokenizer with wrapper unwrapping, path canonicalisation with symlink resolution, secret-path rules,
  detached-process and network rules, supervisor-tamper protection, and a 230+ case fixture corpus.
- Quarantined runs in a disposable git worktree/branch with a main-tree integrity fingerprint.
- SQLite (WAL) event log with redaction, test-result parsing and agent findings.
- Hook adapters for Claude Code (reference), Codex CLI, Gemini CLI, Copilot CLI, Cursor, Grok Build,
  OpenCode, Amp and a generic JSON protocol; PATH shim guard for agents without hooks (Aider, custom).
- Budgets: wall time, action count, consecutive denials, repeated-command loops, idle time, estimated spend.
- Morning report (HTML/Markdown/JSON) ranked by usefulness, live loopback dashboard, patch export, cleanup.
- CLI: init, run (foreground or --detach), status, stop, report, clean, purge, policy, hooks, doctor, agents.
- VS Code extension (thin client over the CLI).
