---
title: The permission gate
description: Why the rule is what git can undo rather than which tool asked, why every tool passes through one function, and why only some approvals can be remembered.
sidebar:
  order: 2
---

The goal is one sentence: **run a real task start to finish without a prompt,
and still stop before anything git cannot undo.** Ask about everything and the
tool is unusable; ask about nothing and it is dangerous. This page is where that
line gets drawn.

## The rule

The split is not "bash versus the file tools". It is **what git can undo versus
what it cannot.**

Writing to a file inside the project is allowed silently, whether it came from
`edit_file`, `write_file`, or an `echo >` inside a `bash` command — all three are
the same act, and the repo remembers the old bytes. Deleting, pushing, running
`sudo`, or touching anything outside the workspace stops and asks, whichever
tool asked for it.

One sentence you can say out loud: *git can undo a change to a file in the repo;
it cannot undo a delete, a push, or anything outside the repo.*

Two things follow from that framing that a tool-based split could not give you.
A `bash` command that only edits a tracked file is no longer suspicious just
because it is `bash`. And `write_file` pointed at `~/.ssh/config` is no longer
safe just because it is a file tool.

The "outside the project" row is deliberately not a refusal. *Read this file for
me* about a file that happens to sit outside the workspace is a normal request,
and refusing it outright made a real need impossible to meet. What keeps that
prompt safe is the next section.

## One gate, no second route to the disk

Every tool call passes through **`permitted()` in
`src/core/tools/registry.ts`**, and there is no second place permission is
checked. Path resolution elsewhere resolves paths and judges nothing, so no tool
can refuse — or allow — behind the gate's back. Every tool carries a `request`,
which means the gate has no early exit that skips one.

That is what makes the rule above auditable. There is exactly one function to
read to know what the agent can do without asking.

## Only a suppressible outcome is remembered

When a prompt appears you can answer for this call alone, or for the rest of the
session. The second answer is the dangerous one, and it is governed by a single
rule at the gate:

**Only store a session approval when the outcome is `suppressible`.** A
"remember this" answer to a non-suppressible prompt is treated as "just this
once".

An escape — `sudo`, a force push, writing outside the project — is never
suppressible. So a guardrail can never be switched off, and a refusal you were
meant to see cannot be silently disabled by a yes you gave twenty minutes
earlier to something that merely looked similar. The prompt you get for
`~/.ssh/config` is the same prompt every single time, which is the price of that
door opening at all.

Approvals that *are* remembered are keyed on the **normalized whole command**,
not on its first word. An earlier version keyed on the first word, which meant
that approving `git status` also approved `git push --force` for the rest of the
session. And nothing is written to disk: a permission granted an hour ago must
not still be waiting after a restart.

## Levels and modes, in brief

Under the gate, a command is classified into a rank:

```
  observe  <  recoverable  <  protected  <  destroy  <  escape
     │             │              │           │          │
   reads      edits inside    protected     rm, and    sudo, push,
              the project      paths       friends      dd, mkfs
```

A command made of several stages takes its worst stage. One that cannot be
classified from its text has no rank at all — it is not a sixth level, it just
asks.

A **mode** is then two values, not a code path per mode: a cut point on that
rank, plus what happens above the cut. Everything at or below the cut runs
without asking; everything above it asks — or, in `auto`, goes to a model for a
second opinion first.

Two invariants hold that shape in place. **No mode denies** — a refusal comes
only from a `deny` rule you wrote in `settings.json`, never from the mode and
never from the judge. And **no new cut may be added below `recoverable`**: a
lower cut would auto-run an irreversible action from its text alone. A cut point
is a fact about a command's *text*, and whether a delete was authorized is a
fact about the *conversation* — which is exactly what a cut cannot read.

`settings.json` outranks all of it, including the model. A rule is the user's own
words, so it is returned before the classifier's cut is ever consulted.

For the commands that change modes, see [Commands](/reference/commands); for the
settings keys and rule syntax, see [Settings](/reference/settings).

## Full reasoning

- [`docs/permissions.md`](https://github.com/Xuxyyy/coding-cli/blob/main/docs/permissions.md)
  — the full table, the classifier, the judge in `auto` mode, rule syntax, and
  what was deliberately not built.
