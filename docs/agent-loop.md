# The agent loop

Status: built.
Covers: `src/core/loop.ts`, `src/core/client.ts`, `src/core/session.ts`, `src/core/host.ts`
Read when: changing the turn loop, adding a tool, or wondering why the shape is this way
See also: `permissions.md` (the gate every tool passes), `sessions.md` (what a run stores),
`features.md` (what ships today)

## Context

Three choices shape the code. The **OpenAI SDK** is the model client, so DeepSeek / GLM /
Kimi keep working through `baseURL`. The TUI is **Ink**. It is **one package**, with
`src/core` and `src/ui` as folders rather than workspaces.

There is no sandbox. The welcome screen shows no sandbox status line and `ReadyInfo` carries
no `sandbox` field. Whoever builds one adds both back, in the shape the sandbox actually
needs — it will probably pair with permission modes, so an on/off boolean may be wrong.

## Architecture

One seam holds the whole design together. The loop must never import React, but a tool deep
inside the loop must be able to pause and ask the user something.

```ts
// src/core/host.ts
interface Host {
  confirm(req: ConfirmRequest): Promise<ConfirmDecision>;
  onEvent(e: AgentEvent): void;
  signal: AbortSignal;
}
```

- The Ink app implements `confirm` by storing the promise's `resolve` and rendering
  `Confirm.tsx`. When the user presses a key, it calls `resolve('once')`.
- Tests use a fake `Host` that always returns `'once'`, so the core is testable with no terminal.
- Esc → `abortController.abort()`; the signal goes to both the OpenAI request and
  `child_process`.

### The turn

`messages → model → tool calls? → run → append → repeat`. Every text delta, tool start and
tool end leaves through `host.onEvent`, so `src/ui` and `src/headless.ts` see the same run.

`MAX_TURNS` (20, `loop.ts`) is a **checkpoint, not a ceiling**: every 20 turns without
finishing, the loop asks to continue. `'session'` turns the checkpoint off for the rest of
the run, `'deny'` stops with a message.

### Streaming tool calls

The riskiest part of `client.ts`. OpenAI streams tool calls as string fragments keyed by
`index`, so arguments have to be concatenated before they are anything:

```ts
for (const d of chunk.choices[0].delta.tool_calls ?? []) {
  const call = (calls[d.index] ??= {id:'', name:'', args:''});
  if (d.id) call.id = d.id;
  if (d.function?.name) call.name = d.function.name;
  if (d.function?.arguments) call.args += d.function.arguments;
}
```

`JSON.parse(call.args)` at the end **can fail** — models emit broken JSON. That returns as a
tool error message so the model retries; it never crashes the run. `finish_reason` decides
what happens next: `tool_calls` → loop again, `stop` → done, `length` → the model hit its
output cap and the loop says so.

### What an interrupt leaves behind

**Cancel means keep, with the gaps filled in.** A killed `bash` may already have changed
files, so dropping the round is the more dangerous of the two — `/resume` would hand the
model a workspace it cannot explain. Two places in `loop.ts` do this:

- In the tool loop, an aborted call is not skipped, it is answered with `INTERRUPTED`. Every
  `tool_call` keeps a matching `tool` reply, which is the only shape the API will replay. The
  `save()` at the end of the round then runs as usual, and the abort check at the top of the
  loop stops the run.
- In the `catch`, `save()` happens before the abort check, so a stream cut in the middle keeps
  its partial text. Only the text — `partial.toolCalls` can hold calls with truncated JSON
  args, and writing those would create the dangling calls the rule above exists to prevent.

The transcript stays honest either way: a killed command reports `[exit 130] stopped by the
user`, and a call that never started says `[interrupted by the user]`.

## Context pressure

**The one rule the whole design rests on: a summarizing compaction only ever happens when no
run is in flight.** That is turn 0 of a run, or `/compact` typed at the prompt (gated on idle
in `src/ui/agent.ts`). Because the situation cannot arise, a split `tool_calls` pair, a
"continue from here" prompt, retry counters and a per-run compaction cap are all unnecessary —
not by careful coding, but because there is nothing in flight to break.

### Two operations, not one

*Clear* and *compact* are different words in the code, the UI and this doc. Blurring them is
what made the earlier attempt hard to reason about.

| | clear (`src/core/clear.ts`) | compact (`src/core/compact.ts`) |
| --- | --- | --- |
| costs | nothing | a full-context request |
| loses | nothing — every byte is on disk | information |
| runs | mid-run, every turn over the line | turn 0, or `/compact` |

Clearing removes only what can be recovered: the file is still on disk, so a `read_file`
result is a cache, not a record. Compacting throws away the conversation itself, which is why
it is confined to a boundary.

`compactSession` has exactly two callers — `/compact` and turn 0 — and both run with nothing
in flight. Do not add a third or a second summarizer.

### The three lines

```
        0.8 × window            window − 32,000              window
             │                        │                        │
  ───────────┼────────────────────────┼────────────────────────┼──
     work    │   clear each turn      │   stop, say how to     │  provider refuses
             │   (compact at turn 0)  │   recover              │
```

| window | threshold (0.8) | floor | room between |
| --- | --- | --- | --- |
| 262,144 — five of the six models | 209,715 | 230,144 | 20,429 |
| 200,000 — `glm-4.7-flash` | 160,000 | 168,000 | 8,000 |

The room between the two lines is what clearing has to work with. At 262,144 it is two or
three tool results, which is enough. `glm-4.7-flash` has 8,000 tokens there — smaller than one
`read_file` result, so on that one model a run can cross the threshold and reach the floor in
a single turn. That is a known limit of that model, not a reason to move the threshold for
everyone.

### The threshold

At the top of every iteration, before `streamTurn`, `overThreshold(session, env, registry)`
(`session.ts`) compares the projection against `contextWindow * 0.8`.

On a yes at `turn > 0` the loop calls `clearRecoverable(session, target, registry)` and emits
`context_cleared` with the tokens freed. Clearing aims at the threshold, not at zero: it stops
as soon as the projection is back under the line, so recent reads survive when they can.

When clearing frees nothing the loop sets `session.clearingExhausted` and emits one
`context_threshold_reached` — `reportedThreshold` keeps that to once per run. A later turn
that *does* free something takes the flag back, so it always means "the most recent attempt
found nothing". Without that retraction the flag would stick after a turn that freed nothing
only because the one clearable result was still in the round in flight, and the next message
would compact a session under no pressure at all. **Being exhausted does not stop the run.** The band between the threshold and the floor is ordinary
work at full fidelity — nothing has been lost there — and giving it up would waste capacity
already paid for.

At `turn === 0` the loop takes the other branch: over the line, or `clearingExhausted` left
over from the previous run, means clear first (it costs nothing) and then summarize if that
was not enough. The task message is taken **off** the list before the summarizer is asked, and
pushed back after — it has to be pushed back anyway, because `compactSession` replaces every
non-system message. The store keys written messages on object identity, so re-pushing the same
object appends nothing, and a failed summary leaves `session.messages` untouched, so the pop
and the push cancel out. A summary that fails is one `error` event and the run continues.

**Take the task off first, and never leave it on.** An earlier version asked the summarizer
with the task still last, so the summary could be "aimed at" the work about to start. What the
model actually receives then is two `user` messages in a row — a job, then "summarize the
above" — and it may answer the job. A live run on `deepseek-v4-flash` did exactly that: with
no tools offered, the model's tool-call syntax came out as plain text, and that text became
the summary and replaced a whole task's history. This only works because the task is last,
which is true at turn 0 by construction and nowhere else in the loop.

**The ordering removes one trigger; `summaryFrom` guards the class.** Whatever the request
looks like, the reply still has total power: `compactSession` deletes every non-system message
and puts that one string in their place, and `messagesOf` replays the record it writes as
"drop everything before this", so a bad summary is unrecoverable on disk too. The old check
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
one notice, `compaction threshold reached`, plus errors. `context_cleared` is drawn nowhere —
clearing is bookkeeping, and a line per turn would bury the work. `compact_start` and
`compact_end` set and clear the `Compacting…` spinner label instead of printing anything, so
the pair is visible while it runs and leaves nothing behind. `compact_end` therefore fires on
failure as well as success: it is what puts the spinner back. `src/headless.ts` prints none of
the three.

This is also the whole recovery path. A run that stops at the floor needs no new code: the
user sends the next message, turn 0 sees the session is over the line, it compacts, and the
task runs.

**Why that point and no other.** It is the only place in the loop that is always a safe cut.
Every assistant message carrying `tool_calls` has its `tool` replies pushed before the loop
comes back around, so no pair can be split, and the API never sees a dangling call. It also
catches the failure a check in the UI cannot — *one long task* that fills the window with
tool output, never returning to the prompt — and `src/headless.ts` gets it free, because it
calls the same `runAgent`.

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
is a system prompt and tool definitions, a few hundred tokens against ~209,000 — but a test
with an absurdly low `ACC_COMPACT_AT` will see it, and that is correct: the estimate is the
only reading available, and it is the same one `/context` shows.

`contextStatus` is left alone, so `/context` still prints the last measured total. The
projection is for the trigger, which has to act; the readout is for the user, who is better
served by the number the provider charged. The two differing by a little is correct, not a
bug.

`ACC_COMPACT_AT` overrides the fraction when it parses to a number in `(0, 1]`. It exists so
a live test can fire the trigger at a few thousand tokens instead of 210,000, and it stays as
the escape hatch if 0.8 turns out to be wrong.

### The floor below the trigger

Below the threshold block, on **every** turn, the loop checks that the next request actually
fits:

```
projectedTokens(session, registry) + MAX_OUTPUT_TOKENS > session.contextWindow
```

On a yes it emits one `error` — `stopped: the context is full and nothing more can be freed;
send your next message and it will compact first` — plus `turn_end`, and returns. The message
names the remedy because there is one; telling the user to start a new session would throw
away work the summary carries across.

**Why a check and never a reaction to the rejection.** At 100% of the window the provider
refuses the request, and at that moment compaction cannot save the run either: the compaction
request is `[...every message, "summarize this"]`, which is *larger* than the request that was
just refused. Summarizing is the one move unavailable at the wall. So the wall has to be seen
coming.

`MAX_OUTPUT_TOKENS` (32,000, `client.ts`) is the right reserve because the reply has to fit
too. Note what this implies about the window: the reserve only sits above the 0.8 line when
the window is at least 160,000 tokens. Every real model in the table is 200,000 or more, so
this holds today — but a small-window model added later would trip the floor below its own
compaction line.

Ordering matters. Both the clearing block and the turn-0 compaction sit above the floor, so
the floor is reached only when freeing space has already been tried and was not enough.

### What clearing touches

Chosen **by tool name**, resolved through a `tool_call_id → name` map built from the assistant
messages — a `tool` message alone does not say which tool produced it.

| | |
| --- | --- |
| `read_file` result | replaced whole; the file is still on disk |
| `bash` result | keeps its `[exit N]` line, loses the body below it |
| `write_file` **arguments** | `content` replaced, `path` kept |

`read_file` results are capped at 32,000 chars, but a `write_file` call carries a whole file
body in `arguments` with no cap at all — often the single largest item in the context, and
recoverable because the file on disk now holds exactly those contents.

**A marker is only written when it is smaller than what it replaces**, measured in estimated
tokens, not characters — CJK text costs about a token per character, so raw lengths compare
backwards. `CLEARED_READ` is 54 characters, so clearing a one-line file read would *add* about
11 tokens. Without the guard that growth was reported as `0` freed, which the loop reads as
"nothing left to free" — so a clear that made things worse looked identical to a clear that
had nothing to do, and bought an unnecessary summary on the next message. The guard also makes
the return value honest: replacements can only shrink, so `before - after` can never go
negative and needs no clamp.

Never touched: the system message, user messages, assistant text, and the **results** of
`edit_file` and `write_file`. An `[exit N]` line and a `Wrote 40 chars to 'a.ts'.` are the
record that something already happened; at a few tokens each there is nothing to gain and a
real record to lose. Nothing at or after the last assistant message carrying `tool_calls` is
cleared either — that is the round in flight.

`content` and `arguments` are mutated **in place**. `written` in `store.ts` is a
`Set<Message>` keyed on object identity, so a mutated message is not re-appended by
`appendTurn`. Every marker is checked before it is written, so a second pass frees 0 and says
so.

### Why there is no mid-run summary

This is the decision most likely to be re-proposed, so it is written down. A model continuing
from a compressed context mid-task produces work that *looks* like progress: it re-applies an
edit that already landed, re-decides something that was settled, or drops a constraint that
only existed in the deleted history. In a coding agent those land on disk.

An earlier attempt did summarize mid-run. At `ACC_COMPACT_AT=0.02` it compacted eight times
from one prompt and had to be stopped by hand — a summary that gets back under the line is not
the same as progress.

A stop is honest: the workspace is in a known state and recovery is one message.

### Still unsolved

- `edit_file` **arguments** are never freed. Unlike `write_file`, the old string is not
  recoverable from the file after the edit lands.
- A task whose *irreducible* context is larger than one window cannot be finished by clearing
  or summarizing. It needs the user to re-prompt.
- `src/headless.ts` has nobody to re-prompt, so an autonomous run ends at the floor.
- Structured note-taking — the agent writing its progress to a file — is what would let a long
  task survive without either summarizing mid-run or stopping.

## Permission

Not here. `permitted()` in `src/core/tools/registry.ts` is the single gate every tool passes
through, and `permissions.md` is the doc.
