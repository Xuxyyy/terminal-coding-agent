---
title: Tools
description: The five tools acc gives the model — what read_file, grep, edit_file, write_file, and bash each take, what they return, where they cap their output, and what happens before any of them runs.
sidebar:
  order: 3
---

The model gets five tools: read a file, search with ripgrep, edit one exact
piece of text, write a whole file, run a shell command. They are all it has
until you add a server. None of them reaches the network, none opens a browser,
and none reaches a file outside the workspace without asking you first.

| Tool | What it does |
|---|---|
| [`read_file`](#read_file) | Reads a text file back with line numbers, a slice at a time. |
| [`grep`](#grep) | Searches file contents with ripgrep, returning the matching paths. |
| [`edit_file`](#edit_file) | Replaces one exact, unique piece of text in a file. |
| [`write_file`](#write_file) | Creates a file, or replaces everything in one. |
| [`bash`](#bash) | Runs a shell command in the workspace root — tests, git, deletes. |

Five, and not fifteen, because every tool is a slot in the model's attention: it
re-reads the whole list on every step, and two tools that overlap make the wrong
pick *plausible* rather than loud. Anything else a task needs is a shell command
away, and `bash` is one slot rather than twenty.

**Every path is resolved against the workspace root before the tool runs.** A
path that lands outside it does not silently fail — it stops and asks you, every
single time, and that prompt can never be remembered. See
[Permissions](/configure/permissions).

## Limits

Every tool caps its own output, so no single call can outrun the point where the
context window starts being managed. The numbers are in each tool's table below;
two rules are shared.

**Truncation is never silent, and the marker names the repair.** Output cut for
length ends with a marker that names the cap and says to re-read with an offset,
so what the model reaches for is a second call with different arguments, not the
conclusion that the file ended there.

**A read keeps the head** — whole lines, from the top. Keeping the tail instead
would produce a listing with an invisible gap in the middle, which reads as a
real file and would be quoted back as one.

## `read_file`

Reads a text file and returns it with line numbers, so the model can quote a
line back exactly when it edits.

```
 • read_file src/parser.ts — 400 lines
```

Takes an optional `offset` and `limit` to read part of a long file.

| Limit | Value |
|---|---|
| Lines returned by default | 400 |
| Largest file it will open | 512 KB |
| Longest single line | 500 characters, then `... [truncated]` |
| Total output | 32,000 characters |

Lines come back as `number<TAB>text`. The numbering is not decoration — it is
what lets the model copy a region byte for byte and hand it to `edit_file`. The
two tools are designed as a pair.

When the file is longer than what was shown, the result ends with a note like
`[file has 1204 lines; showing 1-400.]`, and the model reads on with `offset`.
Hitting the character cap adds `... [truncated N chars, cap is 32000; re-read
with offset]`.

Reading a directory is an error, not a listing — that is `bash`'s job.

## `grep`

Searches file contents with [ripgrep](https://github.com/BurntSushi/ripgrep).
By default it returns **matching file paths only**, which is how the agent finds
where something lives before reading it.

```
 • grep — 12 files
    └─ rg -l --glob *.ts parse .
```

The command under the row is the flags the model actually chose. Five flags are
on every search and are left out because they say nothing about *this* one.

It searches hidden files, honours your `.gitignore`, and never looks in `.git`.
Other modes return the matching lines with numbers, or a count per file.

| Limit | Value |
|---|---|
| Timeout | 30 seconds, then `search timed out…; narrow it with glob or path` |
| Total output | 32,000 characters |

**`grep` needs `rg` installed.** Without it the tool does not crash — it returns:

```
ripgrep (rg) is not on PATH, so grep cannot run. Use bash with grep -rn instead.
```

and the agent searches with the shell, which is slower and does not respect
`.gitignore`. That sentence is the house style for a tool failure: it names what
broke and the exact call to make instead, because the reader is a model with one
chance to repair the call.

## `edit_file`

Replaces **one exact, unique** piece of text in a file. It takes the old text
and the new text, and prints a diff of what changed.

```
 • edit_file src/parser.ts — +3 −1
```

It takes text rather than a line number or a diff, because line numbers drift
the moment the model applies the first of several planned edits, and a diff
makes it do arithmetic it can get wrong. An exact string either matches or it
does not.

The old text must appear **exactly once**. If it appears zero times you get
`old_string not found in src/parser.ts`; if it appears more than once you get
`old_string appears 3 times in src/parser.ts; include more surrounding text so
it matches once`. Either way nothing is written, and the model retries with more
surrounding lines — replacing the first of several matches would be a silent
wrong edit.

It cannot create a file — that is `write_file`.

## `write_file`

Creates a file, or replaces its whole contents. Missing parent directories are
created. It prints a diff too, so replacing an existing file shows you what went
and the row counts the lines.

```
 • write_file src/report.ts — +42
```

Prefer `edit_file` for changing part of a file — `write_file` rewrites
everything, so a mistake costs the whole file rather than one line.

## `bash`

Runs a shell command in the workspace root, with `bash -lc`. This is how tests
get run, git gets used, and files get deleted.

```
 • bash check the test suite
    └─ npm test
```

The row shows the model's short description when it wrote one, with the real
command underneath. With no description, the command sits on the row itself.

Output always begins with the exit code:

```
[exit 0]
```

| Limit | Value |
|---|---|
| Timeout | 120 seconds, then `command timed out after 120s` |
| Output kept | first 10,000 and last 20,000 characters |

Long output is cut **in the middle**, not the end — you keep the command that
started it and the error that ended it — and the cut is marked
`... [truncated N chars]`. Pressing Esc stops the command and the result reads
`[exit 130]` / `stopped by the user`.

`bash` is the tool most likely to stop and ask you. Deletes, anything reaching
outside the project, and anything `acc` cannot classify all need your
approval — [Permissions](/configure/permissions) has the rule, and the `allow`
list is how you stop being asked about a command you trust.

## MCP tools

An [MCP server](/configure/mcp) adds more tools, published beside these five and
named `mcp__<server>__<tool>`. You never call one by name — the model picks it
the way it picks these five, from the description the server sent at startup.

What those tools can reach is the server's business, not this page's, which is
why **every one of their calls asks before it runs**. No mode and no rule
silences that.

## How a tool call runs

Before `run` is ever reached, the same sequence happens for every tool: find the
tool, parse the raw argument string, validate it against the schema, pass
[the gate](/configure/permissions), back up the file if this is a write, then
run.

Every failure in that sequence comes back as tool-result **text**, not a throw.
The loop never sees an exception from a tool, which is what lets a broken call
be repaired by the model rather than ending the turn. A schema failure names
each bad field with its own message, so one argument gets fixed instead of the
whole call being guessed at again.

Every tool is the same record — a name, a description, a schema, an optional
`request`, and a `run` — and no tool has a special path through the loop. Two of
those fields do more than they look like they do:

| Field | What it really is |
|---|---|
| `description`, and every field description | **the prompt.** The schema is converted to JSON schema and handed to the API, so the wording on a field is the only instruction the model ever gets about it. Editing it is editing the prompt. |
| `request` | **whether the call reaches the gate at all.** A tool without one returns immediately from `permitted()` and can never prompt. Every tool carries one today, so that exit never fires. |

Tool definitions are their own line in [`/context`](/configure/commands), and
JSON schema is mostly punctuation — it tokenizes far closer to one token per
character than to four, so a long field description costs more window than its
length suggests.

## Full reasoning

- [`docs/tools.md`](https://github.com/Xuxyyy/coding-cli/blob/main/docs/tools.md)
  — every tool's arguments and return strings, all four read caps, path
  resolution, and the checklist for adding a tool.
