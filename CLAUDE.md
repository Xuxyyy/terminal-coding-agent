# coding-cli

`acc` — a small coding agent CLI. The workspace is the current directory.

## Design docs

These are **not tracked by git**, so they will not be in a fresh clone or a
`git worktree`. Ask for them if they are missing.

- `docs/PLAN.md` — v1: the agent loop, the tools, the original nine-line
  permission layer. Parts of it are now stale; the code wins.
- `docs/PLAN-v2.md` — v2: the permission classifier. Read this before touching
  anything under `src/core/permission/`. It explains the rule the code follows
  ("git can undo it, or it cannot"), the five levels, and why the port drops
  Python's dead `UNDOABLE` level.
- `notes/` — session handoffs. Scratch, safe to ignore. This stays at the root
  because that is where the handoff tooling writes.

## Permission layer

`permitted()` in `src/core/tools/registry.ts` is the single gate. Every tool
passes through it. Session approvals are remembered only when the outcome is
`suppressible`, which is what stops a guardrail from ever being remembered.
