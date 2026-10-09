---
title: Tools
description: The six built-in tools and their availability by permission mode — what read_file, grep, edit_file, write_file, bash and agent each take, what they return, where they cap their output, and what happens before any of them runs.
sidebar:
  order: 3
---

There are six built-in tools. Default `auto` mode offers four: `edit_file`,
`write_file`, `bash`, and `agent`. Reads and searches use Bash. `ask-edits` and
`auto-edits` also offer `read_file` and `grep`.

File and shell execution defaults to Sandbox Off.
Permission checks apply in both modes. With Sandbox On, extra network access and
host paths require approval for each call, and known credential storage stays hidden.

| Tool | What it does |
|---|---|
| [`read_file`](#read_file) | Reads a text file back with line numbers, a slice at a time. |
| [`grep`](#grep) | Searches file contents with ripgrep, returning the matching paths. |
| [`edit_file`](#edit_file) | Replaces one exact, unique piece of text in a file. |
| [`write_file`](#write_file) | Creates a file, or replaces everything in one. |
| [`bash`](#bash) | Runs a shell command in the workspace root — tests, git, deletes. |
| [`agent`](#agent) | Hands one self-contained job to a sub-agent and waits for its answer. |

The offered tool list is chosen by permission mode. In `auto`, tool
descriptions prefer Bash for reads and searches, and Edit or Write for ordinary
file changes so `/rewind` can use their backups. Shell edits remain allowed,
but are not backed up. Read and Grep are unavailable in `auto`, including as
fallbacks. These preferences live in tool descriptions; the base system prompt
is shared across permission modes.

**Every path is resolved against the workspace root before the tool runs.** A
path that lands outside it receives further permission checks. In `auto`, the
judge may allow it; otherwise the user is asked. An outside-path approval is
never remembered. With Sandbox On, extra access requires explicit approval
for each call. See
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

Runs a shell command in the workspace root, with `bash --noprofile --norc -c`
with the current sandbox mode. This is how tests get run, git gets used, and files get
deleted. Personal shell startup files do not load. Each call gets a private HOME
and temporary directory; provider credentials and the model relay URL are omitted.

With Sandbox On, network is off by default. An optional `access` object can request `read_paths`,
`write_paths`, or `network: true`. Extra access asks for approval once for that
call and its children, and is never remembered. Credentials remain protected.
A network grant allows data the command can read to be sent outward.

Sandbox defaults to Off. Use `/sandbox` while idle or `--sandbox on|off` at launch.
The choice lasts for this ACC process; it is not saved. Off ignores `access` and
adds no OS file or network isolation. Permission checks and environment cleanup
remain active; cleanup cannot stop commands from reading credential files.

With On, macOS needs the built-in `sandbox-exec`. Linux needs Bubblewrap and working
namespaces, including inside task containers. A failed backend stops the command;
there is no unsandboxed fallback. A blocked command may already have changed files,
so ACC must inspect its effects before retrying.

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

## `agent`

Hands one job to a sub-agent — a second `acc` loop in the same workspace — and
waits for it to finish. It can use the general child or an optional named global
type.

```
 • agent find where auth lives
```

That one row is all you see. The sub-agent reads files, runs commands and asks
you for permission exactly as `acc` does, but none of its steps are drawn: no
second spinner, no tool rows of its own, no running text. When it stops, its
final message becomes the tool's result and the conversation carries on.

Takes `description`, the few words in that row, `prompt`, the whole job, and
optional `agent`, the named type to use. When no type is selected, the child
inherits the parent's model, permission mode, and every available tool except
`agent`.

**It is for saving your context, not for speed.** Nothing runs in parallel. A
sub-agent that reads twenty files to answer one question spends those twenty
reads in its own context window, which is thrown away when it returns — what
comes back to your session is the paragraph. That is also its limit: the answer
is one message, so a job whose *working* you need to see is one to run yourself.

**You are still asked about everything it does.** The `agent` call itself never
prompts, but every file it writes and every command it runs reaches
[the gate](/configure/permissions) the same way yours do. Those prompts read
`sub-agent: …`, so you can tell whose call you are approving. A "yes, this
session" you have already given is not asked again.

Its tokens are counted in the turn and in the session total, and deliberately
left out of the context bar — they were never in your context.

A sub-agent is never given `agent`, so it cannot start one of its own. A named
type can choose another model, append role instructions, limit tools exactly,
and request a stricter permission mode. See [Subagent](/configure/subagent) for the
definition format, defaults, and failure behavior.

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

- [`docs/tools.md`](https://github.com/Xuxyyy/terminal-coding-agent/blob/main/docs/tools.md)
  — every tool's arguments and return strings, all four read caps, path
  resolution, and the checklist for adding a tool.
