# Contributing to Nightwatch

Thanks for helping make unattended agent runs safer. A few ground rules keep the project trustworthy.

## Principles

1. **Deterministic rules stay authoritative.** No model decides whether a dangerous action runs.
2. **Fail closed.** Any parse error, unknown tool or missing session becomes a deny with a reason code.
3. **Say "guarded", never "sandboxed".** Hooks are an enforcement point, not OS isolation.
4. **Every policy change ships with fixtures.** Add cases to `fixtures/commands/` that prove the new behaviour.

## Development

```bash
npm ci
npm run build        # tsc -b across packages
npm test             # unit tests + policy corpus + end-to-end run with the fake agent
npm run fixtures     # policy corpus through the CLI
node packages/cli/dist/bin.js --help
```

Node 22.13+ is required (the event store uses the built-in `node:sqlite`). Tests run on Linux, macOS and
Windows in CI; please keep paths and shell assumptions cross-platform.

Try a full run without an API key using the fake agent: see `scripts/fake-agent.mjs` and the e2e test in
`packages/cli/src/e2e.test.ts`.

## Layout

```
packages/shared   types, reason codes, redaction, path canonicalisation
packages/policy   command tokenizer, rule catalog, engine, presets, fixture runner
packages/daemon   SQLite store, git worktrees, agent profiles, shims, runner, dashboard
packages/hook     per-agent hook adapters, session lookup, shim entry point
packages/report   report model + HTML/Markdown renderers
packages/cli      the `nightwatch` command
packages/vscode   VS Code extension (thin client over the CLI)
fixtures/         allow/deny command corpus and hook payload samples
docs/             policy, agents, architecture, threat model, integration protocol
```

## Adding an agent

1. Add a hook adapter in `packages/hook/src/adapters/` that maps the agent's payload to canonical tools and
   emits its native decision format. Add a payload sample to `fixtures/hooks/`.
2. Add a launch profile in `packages/daemon/src/agents.ts` (binary, args, where hook config is written,
   stream format, coverage statement).
3. Document it in `docs/agents.md` and mark it experimental until someone has verified it end to end.

## Pull requests

Small, focused PRs with tests. CI must be green on all three operating systems.
