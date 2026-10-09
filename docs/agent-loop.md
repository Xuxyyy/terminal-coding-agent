# The agent loop

Status: built.
Covers: `src/core/loop.ts`, `src/core/client.ts`, `src/core/session.ts`, `src/core/host.ts`
Read when: changing the loop, adding a tool, or wondering why the shape is this way
See also: `tools.md` (what each tool takes and returns), `permissions.md` (the gate every
tool passes), `sessions.md` (what a run stores), `features.md` (what ships today)

## Words

One word, one meaning. The code used `turn` for two different things until it was split.

- **turn** — one prompt to its final answer. The whole `while` in `runAgent`. The `turn_end`
  event marks its end, and that is what the UI waits for.
- **step** — one iteration of that loop: one model request plus the tools it asks for.
  `streamStep`, `appendStep`, `NORMAL_STEP_POLICY`.
- **response** — what the model produced inside a step. `AssistantResponse` holds its content,
  tool calls and usage.
- **call** — one entry in a response's `tool_calls`.

Note that the Agent SDK's `maxTurns` counts what this codebase calls a **step**. Both readings
of `turn` are in use in the wider world; this project picked the conversational one because
step counts appear in text a user reads.

## Context

The model client uses **Gemini's native Interactions API** through `@google/genai`.
`gemini.ts` adapts requests and responses to the OpenAI-shaped message and chunk types
used internally by `client.ts`; OpenAI is a type dependency, not the provider transport.
History is kept locally and sent with each request using `store: false`.
The TUI is **Ink**. It is **one package**, with `src/core` and `src/ui` as folders.

The base system prompt is shared across permission modes. It asks the agent to follow
repository instructions, preserve unrelated work, respect permission denials, apply and
verify a candidate solution, and avoid repeating checks without a specific reason.
Sandbox instructions and an environment block follow. In `auto`, tool descriptions
supply the preferences for Bash reads and searches and file-tool edits.

Tools execute with the process sandbox mode, Off by default, independently of permission mode. The model client,
approval host, and private session store remain outside. Backups receive bytes read by a
mode-aware worker instead of reopening model-supplied paths on the host. See `sandbox.md`.

## Architecture

One seam holds the whole design together. The loop must never import React, but a tool deep
inside the loop must be able to pause and ask the user something.

```ts
// src/core/host.ts
interface Host {
  confirm(req: ConfirmRequest): Promise<ConfirmDecision>;
  onEvent(e: AgentEvent): void;
  onModelUsage?(usage: ModelTokenUsage): void;
  signal: AbortSignal;
}
```

- The Ink app implements `confirm` by storing the promise's `resolve` and rendering
  `Confirm.tsx`. When the user presses a key, it calls `resolve('once')`.
- Tests use a fake `Host` that always returns `'once'`, so the core is testable with no terminal.
- Esc → `abortController.abort()`; the signal goes to the Gemini request,
  `child_process`, and the judge call. Esc means *stop the turn*
  wherever it is pressed — including inside the approval box. `n` is the only key
  that refuses one command.

### The turn

`messages → model → tool calls? → run → append → repeat`. Every text delta, tool start and
tool end leaves through `host.onEvent`, so `src/ui` and a test's `Host` see the same run.

**A tool may report tokens it spent.** `ToolOutput` carries an optional `usage`, and
the loop folds it into the turn total and into `session.usage` — but through
`recordToolUsage`, never `recordUsage`. The difference is the one that matters:
`recordUsage` also calls `setMeasured`, which is what drives the context bar, and
those tokens are not in this session's context. `agent` (`tools.md`) is what spends
them — a sub-agent burns its own window and returns one paragraph — so counting
them against the parent's context would show a bar climbing toward a compaction
that nothing in the conversation justifies. The money is real and is counted; the
context is not and is not.

`NORMAL_STEP_POLICY` in `step-policy.ts` shares defaults between interactive and
headless runs: a soft review every 10 completed model turns and a hard boundary
at 60. A model turn may contain several tool calls. The next model request
receives a temporary system-prompt review with the completed count, remaining
turns, and next boundary. It asks the model to finish when required work is
verified, otherwise prioritize essential work over optional improvements.
Reviews are model-only and are never stored in session history.

Interactive runs ask the user after each 60-turn segment. Approval grants another
60 turns; the next review uses the new boundary. The gate cannot be suppressed
for the rest of the turn. `'deny'` stops with a message. Esc returns silently;
the UI reports the stop.

Headless runs pass an explicit `maxSteps` budget, defaulting to the shared hard
boundary. They stop at that budget and return `step_limit`, without interactive
continuation checkpoints. A final answer on the last permitted turn completes
normally. Reviews recur every 10 turns and also warn with ten turns left for a
custom budget. Near the boundary they ask the model to plan required implementation
and verification, and report any unfinished work clearly.

### Streaming tool calls

`gemini.ts` translates native interaction events into the chunk shape consumed by
`client.ts`. The shared accumulator combines tool-call fragments by `index`:

```ts
for (const d of chunk.choices[0].delta.tool_calls ?? []) {
  const call = (calls[d.index] ??= {id:'', name:'', args:''});
  if (d.id) call.id = d.id;
  if (d.function?.name) call.name = d.function.name;
  if (d.function?.arguments) call.args += d.function.arguments;
}
```

`JSON.parse(call.args)` at the end **can fail** — models emit broken JSON. That returns as a
tool error message so the model can repair it. Invalid native argument deltas can also
fail earlier in the Gemini adapter and are handled as request failures. A `length`
finish reason produces an output-limit error when there are no tool calls. The actual loop decision uses
`toolCalls.length`: calls are executed and their results appended before another request;
a response with no calls ends the turn.

### What an interrupt leaves behind

**The rule: every `await` in the loop observes the signal, and the loop never waits on a
promise the signal cannot break.** Esc ends the turn from anywhere inside it — while the
model streams, while a command runs, while the approval box is open, and while the judge is
thinking. The checks that keep that true:

- `loop.ts`, at the top of each step, and again after the step gate's
  `confirm` returns.
- `loop.ts`, at the top of each call in a tool batch.
- `registry.ts`, in `permitted()`, three times: on entry, after the judge answers, and
  after `host.confirm` returns. That last one is what lets the UI abort the controller and
  *then* resolve the open confirm with `'deny'` — `permitted()` re-reads the signal first
  and answers `INTERRUPTED`, so an interrupt never reaches `session.denied` and never
  reaches the judge's prompt as a refusal the user did not make.
- `registry.ts`, in `runTool`'s `catch` — a tool that threw *because* it was aborted reads
  as `INTERRUPTED`, not `Error: The operation was aborted`.

**The honest limit: work that already started is not undone.** A file already written stays
written; a command that already ran stays run. A tool that finished keeps its real result —
a killed `bash` reports `[exit 130] stopped by the user` and still emits `tool_end`. The
work happened, and hiding it would make the next turn wrong.

**Cancel means keep, with the gaps filled in.** A killed `bash` may already have changed
files, so dropping the round is the more dangerous of the two — `/resume` would hand the
model a workspace it cannot explain. Two places in `loop.ts` do this:

- In the tool loop, an aborted call is not skipped, it is answered with `INTERRUPTED`, and
  the batch answers its *remaining* calls rather than breaking out. Every `tool_call` keeps
  a matching `tool` reply, which is the only shape the API will replay. The `save()` at the
  end of the round then runs as usual, and the abort check at the top of the loop stops the
  run.
- In the `catch`, `save()` happens before the abort check, so a stream cut in the middle keeps
  its partial text. Only the text — `partial.toolCalls` can hold calls with truncated JSON
  args, and writing those would create the dangling calls the rule above exists to prevent.

**And the turn says it was interrupted.** The last thing every abort path appends is a `user`
message holding `INTERRUPTED_TURN` — `[the user interrupted this turn]`. Without it a
text-only step just stops mid-sentence and the next turn can read that as *I finished*; the
`INTERRUPTED` tool replies only imply it, and on a step with no tool calls there is nothing
to imply it from. It is stored as a `user` message, which the Gemini adapter sends as
`user_input`, keeping it in the conversation rather than the system instructions.
Consecutive user messages are retained in order. The helper appends nothing when the
marker is already last, so no path can double it, and `appendStep` writes only messages it has
not written yet, so the marker lands on disk as its own record and `/resume` replays it.

The transcript stays honest either way: a killed command reports `[exit 130] stopped by the
user`, a call that never started says `[interrupted by the user]`, and the turn ends with the
marker that says why.

### What a failed turn says

`explainError` in `core/errors.ts` turns recognized failures into a message and
optional hint. It distinguishes request timeouts, insufficient balance or quota,
ordinary rate limits, and daily limits. Other errors retain their original message.
Status is read from the error or its cause so a `StreamFailure` can still explain
the underlying failure.

Each `streamStep` attempt has a 120-second deadline. It aborts the request and
reports `ModelTimeoutError` if the model does not finish. This deadline is separate
from print mode's overall `--max-seconds` limit.

`withRetry` retries supported connection errors, non-daily `429` responses, and
`5xx` responses only before output is emitted. Three retries follow the first
attempt, with 1s, 2s, and 4s backoff. Daily-limit responses, ordinary request or
credential errors, cancellation, and `ModelTimeoutError` are not retried. After
partial output, the loop reports the failure and preserves the partial text.
The Gemini SDK's own retries are disabled, leaving this policy in ACC.

## Context pressure

**Automatic compaction runs at the safe boundary immediately before a model request.** At
that point the prior assistant tool call and every tool result are already in
`session.messages`, so the summarizer sees a complete round and the next request cannot contain
a dangling call. The same boundary exists before the first request of a new user turn and
between tool rounds in one active run.

There is one automatic pressure operation: `compactSession` summarizes the complete history
and, only after a valid summary exists, installs `[system, retained user prompts, summary]`.
At step zero the held pending task is appended after the summary. There is no earlier
result-clearing pass. Manual `/compact` uses the same operation while idle; manual `/clear`
remains the separate command that intentionally starts a new conversation.

### The two lines

```
        0.8 × window            window − 32,000              window
             │                        │                        │
  ───────────┼────────────────────────┼────────────────────────┼──
     work    │ compact before the     │ stop before an         │ provider refuses
             │ next model request     │ oversized request      │
```

| window | threshold (0.8) | floor | room between |
| --- | --- | --- | --- |
| 1,048,576 — all three configured models | 838,861 (rounded) | 1,016,576 | 177,715 (rounded) |

The threshold is the configurable compaction policy. The floor is the physical request-fit
guard, which reserves the maximum 32,000-token reply. They are different checks.
The fit guard also counts any temporary progress-review text, reducing the available
room on review steps.

### The threshold

At the top of every iteration, before `streamStep`, `overThreshold(session, env, registry)`
(`session.ts`) compares the projection against `contextWindow * 0.8`.

On a yes, the loop emits `context_threshold_reached` at most once in the run, then emits
`compact_start` and calls `compactSession` through `withoutText(host)`. Suppressing text keeps
the raw summary out of the transcript. Compaction usage is still added to both the run and
session totals.

For a later step, the completed assistant `tool_calls` message and all its `tool` replies stay
in the compaction input. For step zero, the pending user task is different: its estimated size
must count toward the trigger, but it must not be summarized as old history. The loop therefore
checks the threshold first and temporarily pops that last user message. On success it passes
the same object into `compactSession` as a post-summary message; on failure the loop pushes it
back. Reusing the object also prevents the identity-based session store from appending it twice.

On success, `compactSession` installs the retained prompts, summary, and held task as one
replacement, `compact_end` clears the spinner, and the loop sends the next normal request in
the same run.
On failure, the held task is restored, the detailed history remains unchanged, and the loop
emits `compact_end`, `could not compact; the run stopped`, and `turn_end` before returning. It
does not send another normal request or retry through a different pressure strategy.

The Gemini adapter preserves native interaction steps as hidden continuation state in
an internal `reasoning_content` field. `client.ts` collects it without emitting it to the
UI, and `messages.ts` stores it on assistant messages. Later requests replay those steps
through the adapter. Normal turns, persistence, resume, and model switching retain it.
Compaction removes old state with the old history. The summary is stored with its new
state, but the adapter sends the summary text as `user_input` on later requests.
`estimateMessage` counts the stored continuation even though the terminal never displays it.

**Only prior user prompts survive verbatim.** `retainRecentUserPrompts` walks user messages
newest-first under a 20,000 estimated-token budget, then restores chronological order. Whole
messages keep their object identity. If the oldest fitting boundary is a string, a cloned copy
keeps its newest end behind an explicit truncation marker; structured content is kept only when
it fits whole. Old assistant messages, tool calls, and tool results are represented only by the
summary. The pending step-zero task is outside both the summary and this retention budget.

**The ordering removes one trigger; `summaryFrom` guards the class.** Whatever the request
looks like, the reply still carries every old assistant/tool fact into the replacement, and
`messagesOf` replays that replacement from the compact record. A bad summary therefore remains
unrecoverable from active model context even though recent user prompts survive. The old check
asked only whether the string was empty — the one failure that never happens. So the reply is
checked before it is used. Two rules, both deliberately narrow: a string shorter than
`MIN_SUMMARY` is a refusal or an acknowledgement, not a summary of a full window; and `<|` or
`<｜` is a special-token delimiter every provider builds tool calls out of, so it cannot occur
in prose. Failing either, the summary is asked for once more with a firmer prompt — one bad
sample is the common case, and the session that produced the DSML garbage produced a good
summary minutes later. Two refusals return `null`, the path that was always there: one `error`
event, history intact.

Rejecting a good summary costs a stopped run the next message recovers from; accepting a bad
one costs the conversation. **Keep both rules biased that way.** A check widened to avoid ever
rejecting a real summary has the trade backwards.

**What the user actually sees is deliberately less than what the loop emits.** The TUI draws
one notice, `compaction threshold reached`, plus errors. `compact_start` and `compact_end` set
and clear the `Compacting…` spinner label instead of printing anything, so the pair is visible
while it runs and leaves nothing behind. `compact_end` fires on failure as well as success: it
is what puts the spinner back. A `Host` that ignores these lifecycle events is still correct.

**Why that boundary.** It is the place in the loop that is always a safe cut.
Every assistant message carrying `tool_calls` has its `tool` replies pushed before the loop
comes back around, so no pair can be split, and the API never sees a dangling call. It also
catches the failure a check in the UI cannot — *one long task* that fills the window with
tool output, never returning to the prompt — and any other `Host` gets it free, because they
all call the same `runAgent`.

**The trigger projects:**

```
projected = lastContextTokens + estimateMessages(now) - measuredAt
```

`lastContextTokens` is the API's `total_tokens` for the last request, not the estimator's
guess. `measuredAt` is `estimateMessages` over the same message list at the instant that
measurement was taken. Both fields are written together by the one exported `setMeasured`,
and nothing else assigns either — a single setter is what stops `/resume` from seeding a
total whose `measuredAt` is 0 and projecting the whole restored history twice.

Only the *difference* of two estimates is used, so the estimator's ~28% drift
(`features.md`) applies to the messages added or removed since the measurement, never to the
whole conversation. `recordUsage` runs below the assistant-message push (`loop.ts`), because
`usage.total` already includes the reply; measuring before the reply is in `session.messages`
would count it twice in every later projection.

On a fresh session `projectedTokens` falls back to `contextStatus(...).used`, so the trigger
*can* fire before the first request. At a real 0.8 threshold it never does — a fresh session
is a system prompt and tool definitions, a small prompt against an approximately 839,000-token threshold — but a test
with an absurdly low `ACC_COMPACT_AT` will see it, and that is correct: the estimate is the
only reading available, and it is the same one `/context` shows.

`contextStatus` is left alone, so `/context` still prints the last measured total. The
projection is for the trigger, which has to act; the readout is for the user, who is better
served by the number the provider charged. The two differing by a little is correct, not a
bug.

`ACC_COMPACT_AT` overrides the fraction when it parses to a number in `(0, 1]`. It exists so
a live test can fire the trigger at a few thousand tokens instead of approximately 839,000, and it stays as
the escape hatch if 0.8 turns out to be wrong.

### The floor below the trigger

Below the threshold block, on **every** turn, the loop checks that the next request actually
fits:

```
projectedTokens(session, registry) + auditTokens + MAX_OUTPUT_TOKENS > session.contextWindow
```

On a yes it emits `stopped: the next request would exceed the context window`, then
`turn_end`, and returns. Automatic compaction has already been considered at this same
boundary, so promising that the next user message will change the result would be false.

**Why a check and never a reaction to the rejection.** At 100% of the window the provider
refuses the request, and at that moment compaction cannot save the run either: the compaction
request is `[...every message, "summarize this"]`, which is *larger* than the request that was
just refused. Summarizing is the one move unavailable at the wall. So the wall has to be seen
coming.

`MAX_OUTPUT_TOKENS` (32,000, `client.ts`) is the right reserve because the reply has to fit
too. Note what this implies about the window: the reserve only sits above the 0.8 line when
the window is at least 160,000 tokens. Every configured model in the table has 1,048,576 tokens, so
this holds today — but a small-window model added later would trip the floor below its own
compaction line.

Ordering matters. The compaction threshold block sits above the fit guard, so an over-threshold
history gets its summary attempt before the loop decides whether the normal request fits. The
guard remains necessary for unusual configurations such as `ACC_COMPACT_AT=1`, and for a
summary whose irreducible size still leaves too little reply room.

### Still unsolved

- A history can become too large even for the summary request, because that request contains
  the complete history plus its compaction instruction.
- A task whose *irreducible* context is larger than one window cannot be finished by
  summarizing.
- Structured note-taking — the agent writing its progress to a file — is what would let a long
  task retain facts that even a valid summary omits.

## Permission

Not here. `permitted()` in `src/core/tools/registry.ts` is the single gate for every tool that
carries a permission request. `agent` deliberately skips the gate for the parent call; every
tool its child calls still uses it. `permissions.md` is the doc.
