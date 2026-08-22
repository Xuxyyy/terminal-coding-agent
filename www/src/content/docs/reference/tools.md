---
title: Tools
description: The five tools acc gives the model — read_file, grep, edit_file, write_file, and bash — and the limits each one has.
sidebar:
  order: 2
---

The model has five tools and nothing else. There is no network access, no
browser, and no way to reach a file outside the workspace.

**Every path is resolved against the workspace root before the tool runs.** A
path that lands outside it does not silently fail — it stops and asks you, every
single time, and that prompt can never be remembered.

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

**`grep` needs `rg` installed.** Without it the tool does not crash — it returns
`ripgrep (rg) is not on PATH, so grep cannot run. Use bash with grep -rn
instead.` and the agent searches with the shell, which is slower and does not
respect `.gitignore`.

## `edit_file`

Replaces **one exact, unique** piece of text in a file. It takes the old text
and the new text, and prints a diff of what changed.

```
 • edit_file src/parser.ts — +3 −1
```

The old text must appear **exactly once**. If it appears zero times you get
`old_string not found in src/parser.ts`; if it appears more than once you get
`old_string appears 3 times in src/parser.ts; include more surrounding text so
it matches once`. Either way nothing is written, and the model retries with more
surrounding lines.

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
outside the project, and anything `acc` cannot classify all need your approval.
