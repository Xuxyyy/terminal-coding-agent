---
title: How it's built
description: One seam between the agent and the terminal, the loop that runs a turn, what a run leaves on disk, and how all of it is tested without a terminal or an API key.
sidebar:
  order: 1
---

`acc` is one npm package with two halves that do not know about each other. This
page is the short version of why it is shaped that way. Every section links to
the full argument in the repo at the end.

## The seam

The rule is one line long: **`src/core` runs the agent and never imports React;
`src/ui` draws it with Ink.** They meet at a single interface, `Host`, in
`src/core/host.ts`, and it has three members.

```
        src/core                 │                src/ui
                                 │
  loop, tools, permission gate,  │   Ink components, the confirm
  session store, model client    │   prompt, the scrollback
                                 │
        ── never imports React ──┼── implements Host ──
                                 │
              confirm(request) ──┼──▶  draws a prompt, waits for a key
              onEvent(event)   ──┼──▶  appends to the screen
              signal             │     Esc aborts
                                 │
                          no import points this way ◀──
```

The loop must never import React, and yet a tool buried deep inside it has to be
able to stop and ask the user a question. `Host` is how: `confirm` returns a
promise, and the Ink app resolves it when a key is pressed.

What that buys shows up twice below — the loop runs with no terminal at all, and
so does every test of it.

## The loop

### One word, one meaning

The code used `turn` for two different things until it was split apart. That is
worth naming because a vocabulary bug is a design bug — two meanings behind one
word means every conversation about the code has to disambiguate first, and
eventually someone forgets to.

- **turn** — one prompt through to its final answer. The whole `while` in
  `runAgent`. The `turn_end` event marks its end, and the UI waits for it.
- **step** — one iteration of that loop: one model request plus the tools it
  asks for. `streamStep`, `appendStep`, `MAX_STEPS`.
- **response** — what the model produced inside a step.
- **call** — one entry in a response's `tool_calls`.

The wider world uses both readings of `turn`. This project picked the
conversational one because `MAX_STEPS` appears in text a user reads.

### The shape

`runAgent` in `src/core/loop.ts` is the whole turn.

```
  user prompt
      │
      ▼
  ┌─▶ messages ──▶ model ──▶ response
  │                            │
  │                  tool calls?
  │                    │      │
  │                 yes│      │no
  │                    ▼      ▼
  │              run each   final answer ──▶ turn_end
  │              tool call
  │                    │
  │              append results
  │                    │
  └────────────────────┘
```

It repeats until a response comes back with no tool call. Every text delta,
every tool start and every tool end leaves through `host.onEvent`, so the
terminal and a test see exactly the same run.

`MAX_STEPS` is 20, and it is a **checkpoint, not a ceiling**: every twenty steps
without finishing, the loop asks whether to keep going.

### When the window fills

A long turn eventually runs out of context window, and the design splits that
into two operations that are never confused: *clearing* drops tool results that
can be recovered from disk — a `read_file` result is a cache, not a record — and
costs nothing, so it can run mid-turn. *Compacting* replaces the conversation
with a summary, which loses information and costs a full-context request, so it
is confined to a boundary where nothing is in flight. One rule carries the whole
design: a summarizing compaction only ever happens when no run is in flight.

## What a run leaves on disk

Every run writes to `~/.acc/projects/<name>-<hash>/sessions/<id>/`. The file that
matters is `session.jsonl`: **one `{kind, …}` record per line, append-only**,
with the messages the model sees and the view the terminal drew interleaved in
the same stream.

Messages feed the model; the view feeds the screen. Both are needed because the
diff never enters the messages — replaying an edit from the message history
would print `Edited 'src/cart.js'.` where the screen had shown red and green
lines.

Append-only is the load-bearing choice. At turn 80, with file contents in the
history, a rewrite-every-turn design moves megabytes on every turn and corrupts
the entire conversation if it crashes mid-write. JSONL has no growing array to
rewrite.

**A reader must ignore any record kind it does not know, never error on it.**
That one rule is what lets a new kind of record be added later with no migration
step and no version bump.

### Resume in place

`/resume` opens a picker of past conversations and reopens one **in place** —
`openSession` plus `store.seed(session.messages)`. Nothing is copied into a new
folder, so a resumed run and the original stay one session on disk rather than
becoming two half-conversations that each look complete.

The subtlety worth stating: seed the *live* array, not the stored one. The fresh
system message is a different object, and seeding the stored copy would write a
duplicate of the whole history back into the file.

`/rewind` uses the same picker, one row per user message, and drops the
conversation from that message onward while putting back every file the agent
wrote after it. On disk it **appends a marker** rather than cutting — the
dropped records stay where they are and every reader resolves the marker. So
every consumer sees the short history while the file keeps the long one.

## How it's tested

The seam is what makes the loop testable. Because `src/core` never imports
React, the turn loop runs with no terminal — a test constructs a `Host` and the
loop cannot tell the difference.

That fake lives in `src/tests/fakes.ts`. `fakeHost` returns a `Host` that
records every event into an array and answers `confirm` from a function the test
supplies, so a test can assert on exactly what the user would have been asked
and in what order. Beside it, `fakeModel` builds a client whose streamed chunks
the test writes by hand, which is what makes streaming tool calls, a broken
JSON argument, and a mid-stream disconnect all ordinary test cases.

**No test spends money.** The model client is faked in every one of them; there
is no API key in the suite and no network call.

The suite is **641 tests across 35 files**, laid out as `src/tests/core` and
`src/tests/ui` mirroring the two halves of the seam. `npm test` is the whole
check, and it **typechecks first** — the script is `tsc && node --test`, so a
type error fails the run and nothing executes until it builds.

What a unit test cannot reach is a real terminal: whether the screen actually
redraws, whether a key lands where it should. That is driven by hand in tmux
before a release, not in CI.

## Full reasoning

The design docs in the repo are the long version, and they are the canonical
copy.

- [`docs/agent-loop.md`](https://github.com/Xuxyyy/coding-cli/blob/main/docs/agent-loop.md)
  — the seam, the turn, streaming tool calls, interrupts, and context pressure.
- [`docs/sessions.md`](https://github.com/Xuxyyy/coding-cli/blob/main/docs/sessions.md)
  — the on-disk layout, what every reader does at a compact record, resume, and rewind.
