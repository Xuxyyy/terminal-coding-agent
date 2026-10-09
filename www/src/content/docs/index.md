---
title: acc
description: A small terminal coding agent that reads, edits, and runs code in the current directory.
---

`acc` is a coding agent that lives in your terminal. You start it inside a
project, describe a task in plain English, and it reads the files, searches
them, edits them, and runs commands until the task is done. Permission checks
control file and shell actions; default `auto` mode uses a model judge for
actions above its automatic allowance threshold, then asks you if needed.

It is one npm package with a local test suite. Gemini supplies the model;
conversation history, tools, permissions, and sessions stay in `acc`.

## Three decisions worth defending

- **One permission gate for file and shell actions.** Ordinary project edits
  can run automatically. Deletes, protected paths, and outside actions receive
  further checks. Permission rules and sandbox access grants still apply.
  Automatic allowance does not guarantee that Git can undo a change.
  → [Permissions](/configure/permissions)
- **Editing matches an exact string.** Line numbers drift the
  moment the model makes its first edit; an exact match either applies or fails
  loudly, and loud is recoverable. → [Tools](/configure/tools)
- **Resume reopens a session in place.** The history is seeded back into the
  live conversation rather than copied into a new folder, so a resumed run and
  its original stay one session on disk. → [Architecture](/design/architecture)

## What it can do

- **Four tools in default `auto` mode.** Bash handles reads, searches, and
  commands. `edit_file` and `write_file` make backed-up file changes, and
  `agent` delegates a job. The two edit modes also offer `read_file`, `grep`, and `glob`.
- **One provider, three models.** Gemini uses the native Interactions API.
  Set `GEMINI_API_KEY`; Gemini 3.8 Flash is the default. Pro Preview and
  Flash-Lite are also selectable. Permission judging uses Flash-Lite.
- **Bounded turns.** The agent reviews progress every 10 model turns.
  Interactive runs ask to continue after each 60-turn segment. Print mode
  stops at its selected turn or time limit.
- **Sessions you can reopen.** Interactive sessions are saved. `/resume`
  reopens one in place. `/rewind` restores the conversation and files covered
  by file-tool backups; it cannot undo shell changes. Print runs are not saved.
- **Context management.** `/context` shows window usage. The agent compacts
  automatically at 80% projected usage, or manually with `/compact`, keeping
  recent user prompts and summarizing older context.

## Where to start reading

- **[Architecture](/design/architecture)** — the seam between the agent and
  the terminal, the turn loop, what a run leaves on disk, and how all of it is
  tested without a terminal or an API key. Start here.
- **[Trade-offs](/design/tradeoffs)** — three features that are
  cheap to add and expensive to add wrong, and what each is waiting for.

Want to run it instead? [Install](/start/install) has the four
commands and what the first screen shows.
