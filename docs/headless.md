# Print mode: running a turn with no terminal

Status: built.
Covers: `src/core/headless/host.ts`, `src/core/headless/run.ts`,
`src/core/headless/output.ts`, `src/core/step-policy.ts`, `src/ui/args.ts`, `src/cli.tsx`,
`acc -p "<task>"`
Read when: changing what an unattended run is allowed to do, what it prints, or
what it exits with
See also: `agent-loop.md` (the loop it drives), `permissions.md`
(the gate it still goes through), `sessions.md` (the store it deliberately
skips)

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
the same way in interactive and print mode.

## CLI and core responsibilities

`src/cli.tsx` parses the flags, calls `runHeadless`, prints the result, and sets
the exit code. `runHeadless` returns a `HeadlessResult` object and never prints
anything itself. Formatting lives in `output.ts`, keeping execution separate
from terminal output.

The headless runner lives in core because it implements `Host` and drives
`runAgent`. It imports no React and never imports from `src/ui`; the CLI passes
its parsed options into core.

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

A rule tagged `edit` governs path-taking tools, not shell commands. For
example, denying `edit(**)` does not prevent a shell command from writing a
file. Use the permission mode to control approval for writes across tools.

For predictable unattended runs, set the permission mode deliberately.
`ACC_HOME` redirects the settings file and session store, allowing an isolated
configuration. It does not redirect `~/.acc/.env`, so the API key still loads.

`--yes` answers `'once'`. **Never `'session'`** — nothing is remembered, so
`permitted()` keeps asking on every call and every ask is recorded.

**Every confirm is recorded either way**, request and decision together, and
`HeadlessResult.prompts` carries them out. A silent auto-approve is the one
thing this must never be: the recorded prompts must include confirmations
approved through `--yes`. Actions already allowed by the permission gate do
not produce a confirmation.

## No session is written

`runHeadless` passes no store, which `runAgent` already allows —
`src/core/loop.ts:97` takes `store` as optional. So a print run leaves nothing
under `~/.acc/projects/`, and cannot be reopened with `/resume`.

Repeated print runs do not fill the session store with one-turn conversations.
Callers can save stdout or the JSON event stream when they need a record.

## stdout is the answer, stderr is everything else

Plain mode writes **only the assistant's text** to stdout, so
`acc -p "…" > out.txt` gives the answer alone and a pipe stays useful. Tool
activity, the prompts with their decisions, and the stop reason go to stderr.

`--json` moves the whole event stream to stdout instead: one JSON object per
`AgentEvent` in order, then a final
`{kind: 'result', schemaVersion, stopped, message, usage, tokenUsage, prompts,
steps}` line.
`schemaVersion` versions this public record, and `message` is the authoritative
final assistant text so callers do not need to rebuild it from deltas.
`usage.prompt`, `usage.completion`, and `usage.total` remain the
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

`stopped` is decided in one place, inside `runHeadless`, so all callers
read the same field: `'timeout'` when the timer fired, `'step_limit'`
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
