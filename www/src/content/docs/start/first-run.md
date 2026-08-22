---
title: Your first run
description: The workspace is the folder you start in. What the screen shows, how to read a tool row, and how to stop or leave.
sidebar:
  order: 3
---

## The workspace is the current directory

This is the one thing to know before you start `acc`. It reads and writes files
in the folder you launched it from, and refuses paths outside it. There is no
`--workspace` flag and no way to point it somewhere else — you `cd` first.

```bash
cd ~/code/my-project
acc
```

`acc` refuses to start in your home directory or at the filesystem root, because
"the current directory" would then mean everything you own. It also needs a real
terminal; piping into it does not work.

## What you see

```
Agentic Coding CLI
workspace: /Users/you/code/my-project
permissions: auto-edits
──────────────────────────── DeepSeek v4 Flash ────────────────────────────
```

The workspace, the permission mode the session starts in, and the model. Under
that is an input box. Type a task in plain English and press enter:

```
fix the failing test in src/parser.test.ts
```

Type `/` to open the slash-command menu.

## Reading the transcript

As the agent works, each tool call appears as a row starting with a bullet:

```
 • read_file src/parser.ts — 400 lines
 • grep — 12 files
    └─ rg -l --glob *.ts parse .
 • edit_file src/parser.ts — +3 −1
```

The row is the tool name, then what it was given, then — after the dash — what
came back. While a tool is still running the row reads `running…`, and
`waiting for approval…` when it has stopped to ask you.

- **`bash` and `grep` drop the command onto its own line underneath.** For
  `grep` that always happens — the pattern alone would just repeat the command
  below it. For `bash` it happens when the model wrote a short description; the
  sentence sits on the row and the command sits under it.
- **Edits show a diff.** `edit_file` and `write_file` print the changed lines in
  the scrollback, added and removed, so you can see what happened without
  opening the file.
- **Shell output starts with its exit code**, like `[exit 0]`. Long output is
  cut in the middle and the cut is marked.

## When it asks

Some actions stop and show an approval box:

```
⚠ Command approval required
rm -rf build
deletes 'build', which cannot be undone
y approve once · a allow for this session · n deny
```

The second line is the exact command, and the third says why it stopped.

Press `y` to allow it once, `a` to stop being asked about that command for the
rest of the session, or `n` to refuse. `a` is not always offered — for anything
that cannot be taken back, one-time approval is the only choice. Esc in that box
means the same as `n`.

Refusing does not end the task. The agent is told not to retry, and carries on
with the rest of what you asked.

## Stopping and leaving

- **Esc** while the agent is working interrupts it — the model request and any
  running shell command both stop.
- **`exit`**, **`quit`**, or **`q`** closes `acc`.

Your conversation is saved as you go, so leaving is not losing it.
