# coding-cli

`acc` — a small coding agent CLI. The workspace is the current directory.

## Design docs

One doc per subsystem, in `docs/`. Each opens with what it covers and when to
read it. They record *why*; the code is the truth about *what*.

- `docs/agent-loop.md` — read before changing the turn loop or adding a tool.
- `docs/permissions.md` — read before touching `src/core/permission/`.
- `docs/sessions.md` — read before changing `src/core/store.ts` or `/resume`.

Amend a doc in place when a decision is reversed; leave the original next to the
note, so the reasoning survives. Plans live outside the repo and are disposable
once shipped — fold what lasts into a doc or into this file.

`notes/` is session handoffs. Scratch, safe to ignore. It stays at the root
because that is where the handoff tooling writes.

**`docs/` and `notes/` are untracked.** They are absent from a fresh clone or a
`git worktree`; ask for them if they are missing.

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
