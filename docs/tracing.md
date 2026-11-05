# Execution traces

ACC saves `trace.txt`, a plain-text timing tree, beside `trace.jsonl`.
Each finished task appends one section with its run ID, task label, status,
wall time, and nested operations. Read it directly in an editor or shell:

```sh
cat /path/to/trace.txt
```

Each interactive user task has its own `runId`. Its traces are appended beside
`session.jsonl` in the saved session directory:

```text
$ACC_HOME/projects/<project>/sessions/<session>/trace.jsonl
$ACC_HOME/projects/<project>/sessions/<session>/trace.txt
```

`ACC_HOME` defaults to `~/.acc`. Print-mode runs save traces without creating
a resumable session:

```text
$ACC_HOME/projects/<project>/traces/<trace-directory>/trace.jsonl
$ACC_HOME/projects/<project>/traces/<trace-directory>/trace.txt
```

Plain print mode reports the paths on stderr. With `--json`, the final result
contains `trace.runId`, `trace.path`, and `trace.summaryPath` when the summary
was saved; stdout stays JSONL.

The text tree uses indentation for parent relationships and `@+` offsets
from run start. Child work can overlap other operations or continue after
its launching tool returns. Durations are never added to calculate wall time.
Long child and assignment IDs are shortened with an ellipsis; the full IDs
remain in JSONL. Task labels come from the user's message, with length limits
and controls removed so each label stays on one line. Message and tool details
remain in `session.jsonl` and `trace.jsonl`.

`trace.jsonl` has one JSON object per line and is saved during execution.
`trace.txt` is generated from the same recorded events when cleanup finishes,
including failed and normally cancelled runs. A crash or forced process kill
can leave JSONL records without a text section. Existing traces are not
rewritten or given summaries later.

Each JSONL record includes a version, per-run sequence, timestamp, monotonic
`offsetMs`, `runId`, `spanId`, and `agentId`. Related operations have a
`parentSpanId`; child assignments also have an `assignmentId`. Records use
`phase: "start"`, `"end"`, or `"event"`. Match a start and end by `runId` and
`spanId`; end records include `durationMs` and `outcome`. An operation still
open at run cleanup has `durationKind: "observed_window"` in its end record's
`data`. The text labels that interval as an observed window with an unconfirmed
end, rather than treating it as a known completed duration.

Traces cover model attempts, retry waits, tools, permission decisions,
compaction, recovery, errors, and child assignments. Model evidence includes
request IDs, attempt numbers, reported token usage, first model progress,
and first model text timing. Text produced during compaction is a summary,
not a user-visible answer. Permission timing includes automatic checks,
judge calls when needed, and waiting for user input.

Interactive content stays in the existing transcripts. Their records carry
trace links to the run and model span. Tool trace records identify the tool
call and transcript file. Headless traces retain text and tool-result excerpts
of up to 12,000 characters per operation, plus tool arguments. Excerpts can
be incomplete. Token deltas are not written individually, and tracing adds
no separate reasoning transcript.

Older sessions have no timing trace; timestamps cannot be reconstructed from
their conversation records. A process killed before cleanup may leave unmatched
start records or an incomplete final line. A missing end means the duration
and final outcome are unknown. Recorded usage can also be missing, and cost
stays unknown rather than being reported as zero. A trace write failure does
not stop execution; the UI or print result reports that persistence failed.
If only the text-summary write fails, the JSONL trace remains available.

Saved traces can contain task text, commands, tool output, and paths. They use
private file and directory permissions. Headless traces are not removed by
session retention; delete their trace directories when you no longer need them.
