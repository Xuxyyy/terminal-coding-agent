---
title: acc
description: A small terminal coding agent that reads, edits, and runs code in the current directory.
---

`acc` is a coding agent that lives in your terminal. You start it inside a
project, describe a task in plain English, and it reads the files, searches
them, edits them, and runs commands until the task is done — asking you first
before anything it cannot take back.

It is one npm package, 722 tests, and no dependency on a hosted service:
three providers work through one client, and one API key is enough.

## Three decisions worth defending

- **The permission rule is what git can undo, not which tool asked.** A write
  inside the repo runs silently whether it came from `edit_file` or an `echo >`
  in a shell command; a delete, a push, or anything outside the project stops
  and asks. → [Permissions](/configure/permissions)
- **Five tools, and editing matches an exact string.** Line numbers drift the
  moment the model makes its first edit; an exact match either applies or fails
  loudly, and loud is recoverable. → [Tools](/configure/tools)
- **Resume reopens a session in place.** The history is seeded back into the
  live conversation rather than copied into a new folder, so a resumed run and
  its original stay one session on disk. → [Architecture](/design/architecture)

## What it can do

- **Five tools.** It reads files, searches them with ripgrep, edits one exact
  piece of text, writes whole files, and runs shell commands.
- **Three providers, six models.** DeepSeek, GLM, and Kimi all work through one
  client. One API key is enough — `acc` picks a model from the key it finds.
- **One permission gate.** Everything the agent does passes through it. Changes
  git can undo run silently; deletes, writes to protected paths, and anything
  reaching outside the project stop and ask.
- **Sessions you can reopen.** Every run is saved. `/resume` reopens a past
  conversation where you left it, and `/rewind` takes the conversation *and*
  the files back to before an earlier message.
- **A context readout.** `/context` shows what is filling the window, and
  `/compact` replaces the conversation with a summary when it gets long.

## Where to start reading

- **[Architecture](/design/architecture)** — the seam between the agent and
  the terminal, the turn loop, what a run leaves on disk, and how all of it is
  tested without a terminal or an API key. Start here.
- **[Trade-offs](/design/tradeoffs)** — three features that are
  cheap to add and expensive to add wrong, and what each is waiting for.

Want to run it instead? [Install](/start/install) has the four
commands and what the first screen shows.
