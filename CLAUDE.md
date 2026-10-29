# terminal-coding-agent

`acc` — a small coding agent CLI. The workspace is the current directory.

**This repo is never a workspace.** Everything in `src/` about "the workspace",
`.acc/settings.json`, or the permission gate describes a *user's* project at
runtime — never this folder. `CLAUDE.md`, `.claude/` and `docs/` configure the
agent writing this code, and `acc` never reads them. The two never meet.

## Workflow

Work lands as commits on `main` — do not open a pull request for it.
`/code-review` runs against the local diff or a branch, never a PR number.
Contributions from other people are a different path; `CONTRIBUTING.md` has it.

## Build and test

`npm test` is the whole check: it runs `tsc` first, so a type error fails the
tests, then `node --test` over the compiled `dist/`. Nothing runs until it
builds. On a failure, re-run the one file for full output:
`node --test dist/tests/<path>.test.js`.

Never launch `acc` inside this repo. It edits files in its workspace and the
workspace is the current directory, so it would edit itself — point it at a
throwaway folder.

## The seam

`src/core` runs the agent and never imports React; `src/ui` draws it with Ink.
They meet at one interface, `Host` (`confirm`, `onEvent`, `signal`) in
`src/core/host.ts`. A type both sides need belongs in core: `ContextStatus`
lives in `src/core/session.ts` and `src/ui/events.ts` re-exports it for the
components. No import points the other way.

`Host` has two implementations. `src/ui/agent.ts` is the terminal one;
`src/core/headless/` is a policy-driven one that runs a turn with no terminal —
`acc -p "<task>"`, and the evals importing `runHeadless`. It is in core because
it implements a core interface and imports no React, not because of who calls
it, and it never imports from `src/ui`: `cli.tsx` parses the flags and passes
them down.

`src/evals` is neither. It is a dev tool for this repo — it measures the agent,
it is never shipped inside it, and nothing in `src/core` or `src/ui` may import
it. It lives under `src/` only so `tsc` typechecks it with everything else and
`npm test` picks up its unit tests. The eval itself is not part of `npm test`:
it reaches the network, so it has its own script, `npm run eval:judge`. Its
cases are tracked at `evals/cases/`; its results are gitignored at
`evals/results/`. `docs/evals.md` has the rest.

## Design docs

One doc per subsystem, in `docs/`. Each opens with what it covers and when to
read it. They record *why*; the code is the truth about *what*.

- `docs/agent-loop.md` — read before changing the turn loop.
- `docs/tools.md` — read before adding a tool or changing what one returns.
- `docs/permissions.md` — read before touching `src/core/permission/`.
- `docs/sessions.md` — read before changing `src/core/store.ts` or `/resume`.
- `docs/mcp.md` — read before changing `src/core/mcp/`.
- `docs/features.md` — what ships today; read before planning what is next.
- `docs/evals.md` — read before changing `JUDGE_RUBRIC`, adding an eval, or
  adding a task case.

A doc describes the code as it is now. When a decision is reversed, **rewrite the
part it changed** — do not leave the old version behind with a dated note next to
it. Layered notes turn a doc into a changelog, and a reader cannot tell which
layer is live. Keep a reason only where it still decides something: why the
shape is this way, or what a future change must not break. `git log` is where
the history goes.

`plans/` holds the plan being run, numbered in order — `01-context-readout.md`.
A plan is disposable: delete it once it ships and fold what lasts into a doc or
into this file.

`notes/` is session handoffs. Scratch, safe to ignore. It stays at the root
because that is where the handoff tooling writes.

**`docs/` is tracked** — a fresh clone or a `git worktree` has all six files.
**`plans/` and `notes/` are not.** They are absent from a fresh clone or a
worktree; ask for them if they are missing.

## Documentation

[docs/README.md](docs/README.md) is the documentation index. Keep `README.md`
brief: installation, main behavior and limits, and links to the relevant guides.
Detailed configuration, commands, subsystem design, and evaluation guidance
belong in `docs/`. Update those guides and their links when behavior changes.
Check relative Markdown links instead of running a separate documentation build.

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
