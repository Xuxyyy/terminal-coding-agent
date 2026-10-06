# Print mode: running a turn with no terminal

Status: built.
Covers: `src/core/headless/host.ts`, `src/core/headless/run.ts`,
`src/core/headless/output.ts`, `src/core/step-policy.ts`, `src/ui/args.ts`, `src/cli.tsx`,
`acc -p "<task>"`
Read when: changing what an unattended run is allowed to do, what it prints, or
what it exits with
See also: `agent-loop.md` (the loop it drives), `permissions.md`
(the gate it still goes through), `sessions.md` (the store it deliberately
skips), `evals.md` (its other caller)

Key names, so a search finds this file: `createHeadlessHost`, `HeadlessPolicy`,
`RecordedPrompt`, `runHeadless`, `HeadlessResult`, `StopReason`, `plainLines`,
`jsonLines`, `exitCode`, `--print`, `--json`, `--yes`, `--max-seconds`, `--max-steps`.

## What it is

`acc -p "list the files you can see"` runs one turn and exits. No Ink, no
keyboard, no TTY.

It is a second **implementation** of `Host` (`src/core/host.ts:46`), with an
explicit headless model-turn budget. The terminal `Host` is built inside a
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

**Model turns.** `--max-steps N` sets a positive integer budget, default 60.
`runHeadless` also accepts `maxSteps` directly. This includes the final answer;
a model turn may contain several tool calls. Headless runs use this ceiling
instead of the interactive continuation checkpoint. A budget above 60 can pass
turn 60 under either permission policy. Tool permission checks remain active.

The system prompt states the budget. Progress reviews every 10 completed turns
show the completed count, remaining turns, and boundary. Another review is sent
with ten turns left (or after the first turn
for budgets of ten or fewer). These reminders are model-only. Exhaustion returns
`stopped: 'step_limit'`, emits an error and accumulated usage, and exits 1.
Interactive runs use the same review schedule and a 60-turn checkpoint, where
the user can approve another segment. Both defaults come from `step-policy.ts`.

```sh
acc -p "complete the task and verify it" --max-steps 60 --max-seconds 900
```

**Wall clock.** `--max-seconds`, default 300, is a timer that aborts the
controller. The same signal reaches the model request, `bash`, the permission
judge, and an open confirmation, so the deadline stops work
that is already in flight. Work that completed before the abort is not undone.
A `maxSeconds` of zero or less aborts before the first model call, rather than
racing a timer.

Either cap alone leaves a hole: a fixed number of turns can still take an hour,
and a wall clock alone lets a fast model loop hundreds of times inside it.

## Deny is the default, and silence is forbidden

The policy is `'deny'` unless `--yes` is passed. Fail closed is what the product
does everywhere else.

**What the policy governs is narrower than it sounds, and this is the thing to
get right.** It answers confirms; it does not decide which actions produce one.
An ordinary edit inside the workspace classifies as `recoverable`
(`classify.ts:101`), the default mode `auto` cuts at `recoverable`
(`mode.ts:11`), `withinCut` compares with `<=` (`mode.ts:26`), so `decide`
returns `allow` (`decide.ts:36`) and `permitted()` returns before it ever calls
`host.confirm` (`registry.ts:92`).

So **a headless run under `'deny'` still edits files in its workspace, and
reports `prompts: 0` while doing it.** That is correct: it is the same thing the
terminal app does without asking. The policy only answers confirms that reach
the host. In `auto`, above-cut actions go to the model judge first; a judge
allowance can run them without a confirm. Protected paths, deletes, anything
reaching outside the project, escapes, and unclassified commands reach the
policy when the judge asks.

A genuinely read-only run has to be configured, not assumed, and there is only
one setting that does it: `"permission_mode": "ask-edits"`, which cuts at
`observe` so every write asks — a `bash` write included.

**A `deny` rule is not a second way there**, though it reads like one. Step 7 ran
`{"permissions": {"deny": ["edit(**)"]}}` against a real model: `read_file` and
`edit_file` were both refused, and the model then appended the line with
`bash: printf 'hello\n' >> notes.txt`. That command is still `recoverable`, so
`auto-edits` allows it outright and the rule never sees it. A rule tagged `edit`
governs the path-taking tools; it does not govern the shell. It also denies
**reads**, which is rarely what someone writing `edit(**)` intends.

An eval must set this deliberately — inheriting whatever is in the user's
`~/.acc/settings.json` would make a score depend on who ran it. `ACC_HOME`
(`projects.ts:16`) is how to pin it: it redirects the settings file and the
session store, but not `~/.acc/.env` (`env.ts:5-10`), so the API key still
loads.

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
`src/core/loop.ts:97` takes `store` as optional. So a print run leaves nothing
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
`{kind: 'result', schemaVersion, stopped, message, usage, tokenUsage, prompts,
steps}` line.
`schemaVersion` versions this public record, and `message` is the authoritative
final assistant text so a harness does not need to rebuild it from deltas. The trailing summary
mirrors the judge eval's result file (`evals.md`), so a harness reads a shape it
already knows. `usage.prompt`, `usage.completion`, and `usage.total` remain the
original accumulated fields. `tokenUsage.requests` records each model response
in request order, and `tokenUsage.totals` adds those provider-reported values,
including cache-hit and cache-miss input tokens. When a provider reports only
cached input tokens, cache misses are the provider's input count minus that
cache-hit count; no local tokenizer estimate is used. `steps` is the number of
tool calls the run made — the loop's own iteration count is not derivable from
the event stream, and every step but the last makes at least one call.

## The exit code says whether the run finished

Exit 0 when the turn finished; exit 1 when it stopped early — a denial, a cap,
or an error. The reason is the `stopped` field in JSON and a one-line message on
stderr.

A non-zero exit means **the run did not complete**, which is a different claim
from *the answer was bad*. Nothing here judges the answer.

`stopped` is decided in one place, inside `runHeadless`, so the CLI and any
harness read the same field: `'timeout'` when the timer fired, `'step_limit'`
when the model-turn budget was exhausted, `'denied'` when any tool confirmation
was refused, `'error'` when an error event arrived, else `'done'`. Budget
exhaustion is distinct from permission denial, even if a tool was refused earlier.

## The TTY guard cuts one way only

`src/cli.tsx` still throws `interactive mode requires a terminal` when stdin or
stdout is not a TTY — but that guard now sits inside the interactive branch.
Print mode is exactly the case where neither is a TTY, so the guard had to stop
covering it without loosening for the terminal app. `echo "" | acc` must still
refuse.

## Where the flags live

Flag parsing stays in `src/ui/args.ts`, the CLI's existing front door.
`--json`, `--yes`, `--max-seconds` and `--max-steps` all throw without `-p`,
naming print mode.
Silently ignoring a flag is how someone comes to believe a run was approved when
it was not.

`--version` is the one workspace-independent flag. It prints the package version
and cannot be combined with run options.

The workspace is still the current directory. `--workspace` was removed on
purpose and is not coming back through this door.
