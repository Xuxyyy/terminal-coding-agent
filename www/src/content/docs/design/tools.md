---
title: Designing the tools
description: Why there are five tools instead of fifteen, why every one shares a shape, why editing matches an exact string, and why failure text is written for the model.
sidebar:
  order: 3
---

The model gets five tools: read a file, search with ripgrep, edit one exact
piece of text, write a whole file, run a shell command. This page is about why
that set, and why each one behaves the way it does. What each takes and returns
is in [Tools](/reference/tools).

## Why five and not fifteen

Every tool is a slot in the model's attention. It re-reads the whole list on
every step and picks one, so the list is not free storage — adding a tool makes
every existing tool slightly harder to choose correctly.

Two tools that overlap are worse than one tool that is a little too general,
because overlap makes the wrong pick *plausible*. A `list_directory` tool and a
`find_files` tool both answer "what is in here", and a model that picks the
weaker one for the job does not fail loudly, it just does a worse search and
carries on.

Five is where that stops: read, search, edit, write, run. Anything else a task
needs is a shell command away, and `bash` is one slot rather than twenty.

There is also a cost you can watch. Tool definitions are their own line in
`/context`, and JSON schema is mostly punctuation — it tokenizes far closer to
one token per character than to four. A long field description costs more window
than its length suggests.

## One shape, so a new tool has a known cost

Every tool is the same record: a name, a description, a schema, an optional
`request`, and a `run`. There is no tool with a special path through the loop.

Two of those fields are not documentation.

**The description and every field description are the prompt.** The schema is
converted to JSON schema and handed to the API, so the wording on a field is the
only instruction the model ever gets about that field. Editing it is editing the
prompt, and it should be reviewed like prompt text rather than like a comment.

**`request` decides whether the call reaches the gate at all.** A tool with no
`request` returns immediately from `permitted()` and can never prompt. Every
tool carries one today, so that early exit never fires — which is deliberate,
because the safe default for a new tool is to go through the gate and let
[the rule](/design/permissions) decide, not to skip it.

Before `run` is ever called, a fixed sequence happens: find the tool, parse the
raw argument string, validate it against the schema, pass the gate, back up the
file if this is a write, then run. Every failure in that sequence comes back as
tool-result *text*, not a throw. The loop never sees an exception from a tool,
which is what lets a broken call be repaired by the model rather than ending the
turn.

## Why editing matches an exact string

`edit_file` takes the text to replace, not a line number and not a diff. That is
the choice most worth defending, because the two alternatives are the obvious
ones.

**Line numbers drift.** The model reads a file, plans three edits, and applies
the first — and now every number it held for the other two is wrong by however
many lines that edit added. It has no way to notice.

**Diffs make the model do arithmetic.** A unified diff has hunk headers with
line counts in them, and a model that miscounts produces a diff that either
applies in the wrong place or fails for a reason nobody can read.

An exact string either matches or it does not. And the match must be **exactly
once** — zero matches and two matches are separate errors, and the two-match
error names the count and asks for more surrounding context. Replacing the first
of several matches would be a silent wrong edit; refusing costs almost nothing,
because the model still holds the numbered read and can quote a longer region.

That is also why `read_file` returns lines as `number<TAB>text`. The numbering
is not decoration — it is what lets the model copy a region byte for byte and
know where it came from. The two tools are designed as a pair.

## Caps, and saying what was cut

Every tool caps its own output, so that no single call can outrun the point
where the context window starts being managed. A file is refused above a size
limit, a line is cut at a length limit, and total output is cut at a character
limit.

The rule that makes caps work is that **truncation is never silent, and the
marker names the repair.** Output cut for length ends with a marker that names
the cap and says to re-read with an offset — so what the model reaches for is a
second call with different arguments, not the conclusion that the file ended
there.

Reads are cut from the **head**, keeping whole lines. A file is read from the
top and its line numbers have to stay contiguous; keeping the tail instead would
produce a listing with an invisible gap in the middle, which reads as a real
file and would be quoted back as one.

## Failure text is written for the model, not the user

Every error a tool returns names the next action. The reader is a model that has
one chance to repair the call, and a message that only states the problem leaves
it guessing.

The clearest example is what happens when ripgrep is not installed:

```
ripgrep (rg) is not on PATH, so grep cannot run. Use bash with grep -rn instead.
```

That sentence names what failed, why, and the exact tool call to make instead.
A model that receives it recovers on the next step without being told. `ripgrep
not found` would have been true and useless.

The same shape applies throughout: a schema failure names each bad field with
its own message, so one argument gets repaired instead of the whole call being
guessed at again. An empty search string is refused with a pointer to the tool
that should have been used.

**Errors are prompts.** They are read by the model far more often than by a
person, and they are worth the same care as the system prompt.

## Full reasoning

- [`docs/tools.md`](https://github.com/Xuxyyy/coding-cli/blob/main/docs/tools.md)
  — every tool's arguments and return strings, all four read caps, path
  resolution, and the checklist for adding a tool.
