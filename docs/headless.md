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
that seam uses the same loop and permission gate. Both hosts enable managed
background Bash commands and completion notices.

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

**Model turns.** `--max-steps N` sets a positive integer budget, default 120.
`runHeadless` also accepts `maxSteps` directly. This includes the final answer;
a model turn may contain several tool calls. Headless runs use this ceiling
instead of the interactive continuation checkpoint. A budget above 60 can pass
turn 60 under either permission policy. Tool permission checks remain active.

The system prompt states the budget. Progress reviews every 20 completed turns
show the completed count, remaining turns, and boundary. Another review is sent
with ten turns left (or after the first turn
for budgets of ten or fewer, if another request can follow). Coincident triggers
produce one review. These reminders are appended system messages retained in
saved history; earlier messages stay unchanged. They are not displayed as chat
replies. Exhaustion returns
`stopped: 'step_limit'`, emits an error and accumulated usage, and exits 1.
Interactive runs use the same review schedule and a 60-turn checkpoint, where
the user can approve another segment. The headless default comes from
`core/headless/budget.ts`; interactive checkpoints come from `step-policy.ts`.

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
(`classify.ts:101`), the default mode `auto-edits` cuts at `recoverable`
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

## Background Bash commands

Interactive and print modes offer `bash.run_in_background`, `bash.timeout`, `bash.lifetime`,
`task_output`, `task_stop`, and `task_handoff` in every permission mode. A background launch returns a task ID and
log path while the same command keeps running. A foreground command also moves
to the background when its wait expires; it is never restarted or run twice.

| Limit | Default | Maximum |
|---|---|---|
| Foreground wait | 120,000 ms | 600,000 ms |
| Explicit background runtime | 1,800,000 ms | 7,200,000 ms |
| Combined stdout and stderr | 32 MiB | 32 MiB |

`timeout` is the foreground wait when `run_in_background` is false or omitted,
and the allowed background runtime when it is true. An automatically moved
command receives the default background runtime starting at the transition.
There is no fixed count limit on simultaneous commands. The original
`--max-seconds` deadline and `--max-steps` budget always take priority.

Completion produces one runtime notice for the owning main agent or subagent
between complete model/tool steps. The notice identifies the task and exit status,
instructs the agent to read and check saved output with `task_output`, and does not
grant human approval. If the agent has already replied, the run waits without model
polling, then resumes its loop when a command finishes. Continuations share the
original step count and usage totals. Scheduling and lifetime are separate:

| `bash.lifetime` | Completion behavior |
|---|---|
| `finite` (default) | Wait for completion and inspect the required result. |
| `temporary_service` | Keep running during work; stop during run cleanup. |
| `retained_service` | Preserve after successful normal completion only after readiness verification. |

Services require `run_in_background: true`. The main agent must explicitly
choose retention from the user's task and provide `required_by_task`; ACC does
not infer it from command names. Subagents keep their existing cleanup ownership
and cannot start retained services.

Start a retained service in the foreground of its managed shell, preferably
with `exec`. Do not daemonize or append shell `&`: ACC owns the managed process
group, not an arbitrary escaped descendant. Retained service stdout and stderr
write directly to a private log file. Run
`task_handoff(task_id, command, description, access?)` with a readiness command
that checks the requested behavior, such as the response from an actual HTTP
endpoint. PID existence alone is insufficient. The check has a 10 second limit
and goes through the ordinary command permissions and sandbox access rules.
A failed recheck removes earlier readiness eligibility. The model chooses the
behavioral check; an exit-zero check is not independent proof of task success.

Unverified retained services prompt the model for a check instead of entering
an idle wait. Verified services do not block the final reply. On successful
normal completion, ACC saves a handoff record, detaches the service, and exits.
The record includes the task and owner IDs, command, PID, start time, readiness
evidence, log path, private runtime directory, and a shell stop command. The
final JSON result includes a `services` array; plain output writes service
records to stderr. The final reply should identify the record and logs.

Before handoff, cancellation, timeout, step exhaustion, fatal failure, and
`task_stop` still stop services. After handoff, the environment owns their
lifetime and log growth. Use the recorded stop command to stop the process
group and remove its private runtime directory; logs remain available. The
record is a snapshot at handoff, not a continuing health monitor. Verify process
identity before using an old PID record. The existing POSIX Bash/process-group
runtime requirements apply.

The agent must inspect required results before dependent work or success claims.

`task_output(task_id, offset?, limit?)` returns the task status, exit code or
stop reason, output, and `next_offset`. Offsets count characters from zero;
each page includes at most 30,000 output characters. It never waits for a task.
`task_stop(task_id)` stops that task's process group and waits for cleanup.
After shell exit, ACC drains output for at most one second. If inherited output
connections remain open, it preserves collected output and the shell exit code,
marks `outputIncomplete` and `cleanupUncertain`, and finishes tracking. Explicit
stop, abort, and timeout retain the earlier one-second forced-cleanup fallback
and report cleanup failure when it cannot be confirmed.
Task tools accept only tasks owned by the calling agent. Subagents inherit
background support and wait for their finite commands to complete and be checked.
They can receive parent messages during that wait. Cancellation stops owned work;
remaining temporary services are stopped when their owner finishes, with cleanup
reported to the parent rather than handing over ownership.

Logs and final task metadata are retained under
`$ACC_HOME/runs/<run-id>/tasks/`, or `~/.acc/runs/<run-id>/tasks/` by default.
Directories are private and files use mode `0600`. Output streams to disk
instead of being accumulated in memory. The 32 MiB limit includes output
written before a command moves into the background; exceeding it stops the
command and produces an `output_limit` result. For directly logged retained
services, ACC checks file size every 100 ms while it owns the service, so a fast
writer can exceed the limit between checks. After handoff ACC no longer enforces
the runtime or log-size limit. Saved logs are not resumable
sessions and are not automatically deleted or restarted.

The event stream adds `background_task` events with `started`, `completed`, and `handed_off`
actions, owner, task ID, status, log path, and exit information. Final result
records use `schemaVersion: 2`; successful text and incomplete text retained for
continuation remain in the result, while discarded tool generations remain in
diagnostic events. The programmatic runner accepts an optional abort signal.
CLI `SIGINT` and `SIGTERM`, deadline expiry, step exhaustion, and fatal failure
stop owned process groups and clean temporary command environments before exit.
External cancellation reports `stopped: 'cancelled'` with an interruption message.
Usage already recorded before cancellation remains included.

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

## Explicit coding settings

```bash
ACC_MODEL=deepseek-flash ACC_REASONING_EFFORT=high acc -p "Explain this project" --json
```

Headless runs use the same DeepSeek client and reasoning settings as interactive
runs and subagents. The final JSON result includes `modelSettings` with the
provider, base URL, model ID, reasoning effort, thinking switch, 64,000-token
output limit, and 120-second request timeout. This is an additive field; existing
result fields are unchanged. Auto mode uses DeepSeek for permission judging.

## Recovery evidence and inherited deadlines

`--deadline-ms <Unix milliseconds>` supplies an absolute execution deadline.
The earlier of this deadline and `--max-seconds` wins. The shared abort signal
covers retry waits, compaction, continuations, permission judging, subagents,
and foreground/background tools; these operations never restart the trial clock.

JSON events are written during execution, followed by exactly one final result.
A `run_start` event records effective settings and source identity even if the
process cannot write a final result. `model_attempt_start` and `model_attempt`
correlate requests, attempts, agents, timing, reported usage, timeout phases, and
partial responses. `model_retry`, `response_incomplete`, and `recovery` distinguish
transport retries from the one text continuation and context recovery.

`tokenUsage.attempts` includes missing usage as `null`; `tokenUsage.complete`
indicates whether totals include complete reports for every attempt and field.
Numeric totals sum available reports and must not be treated as complete costs
when reports are missing. Relay and CLI usage records describe the same calls
and must not be added together. Tool execution status is independent of any
benchmark verifier reward. Schema 1 records remain readable by the Harbor adapter.
