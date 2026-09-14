# Agent integrations

Every agent goes through the same engine; only the hook payload shape, the decision format and the launch
command differ. `nightwatch agents` shows what is installed. Coverage is stated in every report because it
differs by agent.

| Agent id | Launch | Hooks | Decision format | Ask supported |
|---|---|---|---|---|
| `claude-code` | `claude -p … --output-format stream-json --settings <run>/claude-settings.json --dangerously-skip-permissions --max-budget-usd` | `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd` via `--settings` (nothing written into the repo) | `hookSpecificOutput.permissionDecision` | yes |
| `codex` | `codex exec -C <worktree> --json --sandbox workspace-write --dangerously-bypass-hook-trust` | `.codex/hooks.json` in the worktree (`PreToolUse`/`PostToolUse`) | same as Claude | no — Codex fails open on `ask`, so defer → deny |
| `gemini-cli` | `gemini -p … --approval-mode yolo --output-format stream-json` | `.gemini/settings.json` in the worktree (`BeforeTool`/`AfterTool`) | `{"decision":"deny","reason":…}` | no |
| `copilot-cli` | `copilot -p … --allow-all-tools --output-format json` | `.github/hooks/nightwatch.json` in the worktree (`preToolUse`/`postToolUse`) | `{"permissionDecision":…}` | yes |
| `cursor` | `agent -p … --force --output-format stream-json --workspace <worktree>` | `.cursor/hooks.json` in the worktree (`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `preToolUse`, …) | `{"permission":…,"user_message":…,"agent_message":…}` | yes (not for reads) |
| `grok` | `grok -p … --yolo --output-format streaming-messages-json --cwd <worktree> --trust` | `.grok/hooks/nightwatch.json` (Claude-style) | same as Claude | yes |
| `opencode` | `opencode run --dir <worktree> --format json --auto …` | `.opencode/plugins/nightwatch.mjs` (`tool.execute.before` throws to block) | plugin exception | no |
| `amp` | `amp -x … --dangerously-allow-all --stream-json --settings-file <run>/amp-settings.json` | `amp.permissions` delegate helper | exit code 0/1/2 | yes |
| `aider` | `aider --message … --yes-always` | none | — | — |

Files written into the worktree are removed again when the run ends and are excluded from the exported patch.
If your repository already has one of those files, Nightwatch merges its hooks in first and restores the
original afterwards.

## The PATH shim guard

Agents without a pre-execution hook (Aider, custom scripts) — and any agent with `shims: true` in
`config.yaml` — get a directory of command shims prepended to `PATH` (`git`, `rm`, `curl`, `npm`, `python`,
`docker`, `kubectl`, `aws`, `psql`, `sudo`, `kill`, …; the list is `shim_commands` in `config.yaml`). Each
shim evaluates the command as a `Bash` tool call, records the event, then executes the real binary with the
original `PATH` so that descendants of an allowed command are not re-judged (the same semantics as a hook,
which sees the command the agent issued, not what it spawns). Limits: absolute paths, shell builtins and
interpreters not in the list bypass the shims. Worktree isolation still contains file writes.

## Custom agents

```yaml
# .nightwatch/config.yaml
agents:
  my-agent:
    template: "my-agent --task {prompt} --dir {worktree}"   # {prompt} {worktree} {run_dir} {project_root}
    hooks: none | claude-settings-file    # claude-settings-file writes Claude-style hook settings to {run_dir}/hooks-settings.json
    shims: true
    stream: text | claude-stream-json | codex-jsonl | cursor-stream-json | gemini-stream-json | opencode-json | generic-jsonl
```

The run environment exposes `NIGHTWATCH_SESSION_ID`, `NIGHTWATCH_DB`, `NIGHTWATCH_WORKTREE`,
`NIGHTWATCH_HOOK_NODE` and `NIGHTWATCH_HOOK_SCRIPT`, so an agent can call the hook itself — see
`scripts/fake-agent.mjs` for a complete example and `docs/integration.md` for the JSON protocol.

## Verifying an integration

The non-Claude adapters follow the vendors' documented hook formats as of September 2026 and are marked
*experimental* until verified end to end on a given version. To verify:

1. `nightwatch doctor --agent <id>` — binary and hook self-test.
2. `nightwatch run --agent <id> --hours 0.1 --task "Run the test suite, then try 'git push' and report what happened"`
3. Check that the report shows the push as `PROD_RISK` denied. If it ran, the hook did not fire: open a
   *Policy bypass* issue with the agent version.

## Windows notes

- Claude Code runs shell-form hooks through Git Bash when available; the generated command uses forward
  slashes and quotes so it works there. Without Git Bash set `hooks_exec_form: true` in `config.yaml` to use
  the exec form (`{command, args}`).
- Shims are `.cmd` files that delegate to `node`; junctions are used instead of symlinks for linked
  dependency directories.
- Killing a run uses `taskkill /T`.
