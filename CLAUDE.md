# coding-cli

`acc` — a small coding agent CLI. The workspace is the current directory.

## Build and test

`npm test` is the whole check: it runs `tsc` first, so a type error fails the
tests, then `node --test` over the compiled `dist/`. Nothing runs until it
builds. On a failure, re-run the one file for full output:
`node --test dist/tests/<path>.test.js`.

Never launch `acc` inside this repo. It edits files in its workspace and the
workspace is the current directory, so it would edit itself — point it at a
throwaway folder. `src/headless.ts` runs the loop with no terminal and
auto-approves every prompt: it can show a run works, never that a prompt did
not appear.

## The seam

`src/core` runs the agent and never imports React; `src/ui` draws it with Ink.
They meet at one interface, `Host` (`confirm`, `onEvent`, `signal`) in
`src/core/host.ts`. A type both sides need belongs in core: `ContextStatus`
lives in `src/core/session.ts` and `src/ui/events.ts` re-exports it for the
components. No import points the other way.

## Design docs

One doc per subsystem, in `docs/`. Each opens with what it covers and when to
read it. They record *why*; the code is the truth about *what*.

- `docs/agent-loop.md` — read before changing the turn loop or adding a tool.
- `docs/permissions.md` — read before touching `src/core/permission/`.
- `docs/sessions.md` — read before changing `src/core/store.ts` or `/resume`.
- `docs/features.md` — what ships today; read before planning what is next.

Amend a doc in place when a decision is reversed; leave the original next to the
note, so the reasoning survives.

`plans/` holds the plan being run, numbered in order — `01-context-readout.md`.
A plan is disposable: delete it once it ships and fold what lasts into a doc or
into this file. Claude Code's own plan mode writes to `~/.claude/plans/`
instead; that is a different thing and nothing here depends on it.

`notes/` is session handoffs. Scratch, safe to ignore. It stays at the root
because that is where the handoff tooling writes.

**`docs/`, `plans/`, and `notes/` are untracked.** They are absent from a fresh
clone or a `git worktree`; ask for them if they are missing.

## Sessions

Every run writes to `~/.acc/projects/<name>-<hash>/sessions/<id>/`: `session.jsonl`
holds one `{kind, …}` record per line — the messages the model sees and the view the
terminal drew, interleaved. Ignore a record kind you do not know, never error on it.
`/resume` opens a picker and reopens a session **in place** — `openSession` plus
`store.seed(session.messages)`, which is what stops the history being copied into
a new folder. Seed the live array, not the stored one; the fresh system message is
a different object.

## Permission layer

`permitted()` in `src/core/tools/registry.ts` is the single gate. Every tool
passes through it. Session approvals are remembered only when the outcome is
`suppressible`, which is what stops a guardrail from ever being remembered.
