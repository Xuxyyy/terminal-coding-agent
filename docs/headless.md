# Print mode: running a turn with no terminal

Status: built.
Covers: `src/core/headless/host.ts`, `src/core/headless/run.ts`,
`src/core/headless/output.ts`, `src/ui/args.ts`, `src/cli.tsx`,
`acc -p "<task>"`
Read when: changing what an unattended run is allowed to do, what it prints, or
what it exits with
See also: `agent-loop.md` (the loop it drives, unchanged), `permissions.md`
(the gate it still goes through), `sessions.md` (the store it deliberately
skips), `evals.md` (its other caller)

Key names, so a search finds this file: `createHeadlessHost`, `HeadlessPolicy`,
`RecordedPrompt`, `runHeadless`, `HeadlessResult`, `StopReason`, `plainLines`,
`jsonLines`, `exitCode`, `--print`, `--json`, `--yes`, `--max-seconds`.

## What it is

`acc -p "list the files you can see"` runs one turn and exits. No Ink, no
keyboard, no TTY.

It is a second **implementation** of `Host` (`src/core/host.ts:42`), never a
change to what the loop does with one. The terminal `Host` is built inside a
React component (`src/ui/agent.ts`) and its `confirm` only resolves when a human
presses a key. The headless one answers from a policy instead. Everything below
that seam — the loop, the tools, the permission gate — is the same code running
the same way. That is the point: a run you cannot compare to the real thing
measures nothing.

## It has two callers, and they enter by different doors

**You, from a shell**, through `acc -p`. `src/cli.tsx` parses the flags, runs
the turn, prints, and sets the exit code.

**An eval, from TypeScript**, by importing `runHeadless` directly and reading
the `HeadlessResult` object — no strings to parse. The judge eval already
imports core this way (`src/evals/judge/run.ts`).

That split is why `runHeadless` returns a result object and never prints
anything itself. Formatting lives in `output.ts`, which only `cli.tsx` calls. A
driver that wrote to stdout would be unusable from the eval, and an eval that
had to parse text would be measuring the formatter.

## Why it lives in core and not in `src/evals`

It could have gone under `src/evals/` with the rest of the dev tooling. It did
not, because of what the code *is* rather than who calls it: it implements a
core interface and drives `runAgent`. That is agent machinery, not measurement
machinery — there is no scoring, no fixture, no rubric in it. `src/evals` stays
the place where *judging* lives.

It imports no React, which is what puts it on the core side of the seam. And it
never imports from `src/ui`: `cli.tsx` parses the flags and passes the options
down, so the arrow points one way only.

## The two caps

An unattended run has nobody watching it, so it is bounded on **both** axes.

**Steps.** `MAX_STEPS = 20` is a checkpoint, not a ceiling: the loop asks for
permission to keep going (`src/core/loop.ts:130`). Print mode always denies that
request, under `--yes` too. A run that answers yes to its own checkpoint has no
upper bound at all, and denying gives the step cap for free with no new
machinery. A larger cap is a flag someone can add later; it is not a default.

**Wall clock.** `--max-seconds`, default 300, is a timer that aborts the
controller. The loop checks `host.signal.aborted` at the top of every step, so
an abort is honoured between steps — not mid-request. A run that stalls inside
one long tool call overruns the deadline and stops at the next step boundary. A
`maxSeconds` of zero or less aborts before the first model call, rather than
racing a timer.

Either cap alone leaves a hole: 20 steps can still take an hour, and a wall
clock alone lets a fast model loop hundreds of times inside it.

## Deny is the default, and silence is forbidden

The policy is `'deny'` unless `--yes` is passed. Fail closed is what the product
does everywhere else, and a script that quietly gained write access to a
workspace is the worst thing this feature could do.

`--yes` answers `'once'`. **Never `'session'`** — nothing is remembered, so
`permitted()` keeps asking on every call and every ask is recorded.

**Every confirm is recorded either way**, request and decision together, and
`HeadlessResult.prompts` carries them out. A silent auto-approve is the one
thing this must never be: an eval that counts prompts would be measuring a lie,
and the count would look best exactly when the gate had been bypassed. If a run
with `--yes` reports zero prompts for a write, that is a bug in `host.ts`, not a
clean run.

## No session is written

`runHeadless` passes no store, which `runAgent` already allows —
`src/core/loop.ts:96` takes `store` as optional. So a print run leaves nothing
under `~/.acc/projects/`, and cannot be reopened with `/resume`.

An eval runs dozens of these back to back and would otherwise flood the store
with one-turn sessions nobody will ever resume, and it keeps its own records
anyway. Revisit if someone asks to resume a print run.

## stdout is the answer, stderr is everything else

Plain mode writes **only the assistant's text** to stdout, so
`acc -p "…" > out.txt` gives the answer alone and a pipe stays useful. Tool
activity, the prompts with their decisions, and the stop reason go to stderr.

`--json` moves the whole event stream to stdout instead: one JSON object per
`AgentEvent` in order, then a final
`{kind: 'result', stopped, usage, prompts, steps}` line. The trailing summary
mirrors the judge eval's result file (`evals.md`), so a harness reads a shape it
already knows. `steps` there is the number of tool calls the run made — the
loop's own iteration count is not derivable from the event stream, and every
step but the last makes at least one call.

## The exit code says whether the run finished

Exit 0 when the turn finished; exit 1 when it stopped early — a denial, a cap,
or an error. The reason is the `stopped` field in JSON and a one-line message on
stderr.

A non-zero exit means **the run did not complete**, which is a different claim
from *the answer was bad*. Nothing here judges the answer.

`stopped` is decided in one place, inside `runHeadless`, so the CLI and any
harness read the same field: `'timeout'` when the timer fired, `'denied'` when
any confirm was refused, `'error'` when an error event arrived, else `'done'`.
Denial outranks error because a denied checkpoint emits both, and the denial is
the fact worth reporting.

## The TTY guard cuts one way only

`src/cli.tsx` still throws `interactive mode requires a terminal` when stdin or
stdout is not a TTY — but that guard now sits inside the interactive branch.
Print mode is exactly the case where neither is a TTY, so the guard had to stop
covering it without loosening for the terminal app. `echo "" | acc` must still
refuse.

## Where the flags live

Flag parsing stays in `src/ui/args.ts`, the CLI's existing front door.
`--json`, `--yes` and `--max-seconds` all throw without `-p`, naming print mode.
Silently ignoring a flag is how someone comes to believe a run was approved when
it was not.

The workspace is still the current directory. `--workspace` was removed on
purpose and is not coming back through this door.
