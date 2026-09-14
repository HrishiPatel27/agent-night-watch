---
name: False-positive denial
about: A safe action was blocked and cost you a run
labels: policy
---

- Command / tool call that was denied (redact secrets)
- Reason code and rule from the report (e.g. `OUTSIDE_WORKTREE` / `path.write.outside`)
- Why it should be allowed, and whether an `allow.*` rule would be an acceptable fix
