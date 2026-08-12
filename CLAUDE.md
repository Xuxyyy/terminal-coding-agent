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
- `docs/PLAN-v3.md` — v3: reliability. Built: the turn-limit checkpoint, narrow
  stream retry, and session resume. Three decisions were reversed in v3.1 and
  carry an amendment note in the file — a session now stores the *view* beside
  the messages, resume replays all of it, and `--resume` / `--sessions` are gone.
- `notes/` — session handoffs. Scratch, safe to ignore. This stays at the root
  because that is where the handoff tooling writes.

## Sessions

Every run writes to `~/.acc/projects/<name>-<hash>/sessions/<id>/`: `NNNN.json`
holds the messages the model sees, `vNNNN.json` holds the view the terminal drew.
`/resume` opens a picker and reopens a session **in place** — `openSession` plus
`store.seed(session.messages)`, which is what stops the history being copied into
a new folder. Seed the live array, not the stored one; the fresh system message is
a different object.

## Permission layer

`permitted()` in `src/core/tools/registry.ts` is the single gate. Every tool
passes through it. Session approvals are remembered only when the outcome is
`suppressible`, which is what stops a guardrail from ever being remembered.
