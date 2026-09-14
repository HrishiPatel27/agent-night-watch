---
name: Policy bypass or false "guarded" state
about: A dangerous action was allowed, or supervision silently stopped
labels: security, bug
---

**Silent bypasses are launch blockers.** Please include:

- Agent and version (e.g. `claude --version`)
- Nightwatch version (`nightwatch --version`) and OS
- The tool call (redact secrets!) and the decision recorded in `nightwatch report --json`
- Whether the action ran (evidence)
