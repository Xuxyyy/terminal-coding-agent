---
title: Sessions
description: Every run is saved. How to reopen a past conversation with /resume and go back in time with /rewind.
sidebar:
  order: 2
---

You do not have to do anything to save your work with `acc`. Every run is
written to disk as it happens.

## Where they live

```
~/.acc/projects/<folder-name>-<hash>/sessions/<id>/session.jsonl
```

The project folder is named after the directory you ran `acc` in, plus a short
hash of its full path, so two projects with the same name never collide.
`session.jsonl` holds one record per line — the messages the model saw and what
the terminal drew, interleaved — and is written as you go, not at the end. Files
are created readable only by you.

Set `ACC_HOME` to keep all of this somewhere other than `~/.acc`.

## `/resume` — reopen a conversation

```
Reopen a conversation
❯ fix the failing test in src/parser.ts                    2h
  add a --json flag to the report command                  3d
↑↓ to move · enter to open · esc to cancel
```

The picker lists past conversations **from the folder you are in**, each shown
by its first task and its age on the right — `2h`, `3d`, `5mo`. A session where
the model never ran is not listed. Choosing one reopens it in place:
the stored transcript is replayed into the scrollback, diffs included, and you
carry on in the same session file rather than starting a copy of it.

## `/rewind` — go back to before a message

`/rewind` opens a similar picker with one row per message you sent, newest
selected. Choosing one takes the conversation back to just before that message —
and takes your files back with it:

```
rewind to before "add a --json flag to the report command"
3 files will be restored:
  src/report.ts
  src/report.test.ts
  docs/report.md   (deleted — it did not exist yet)
files changed by a shell command or by you are not restored
enter to rewind · esc to cancel
```

It always names the files first and waits for `enter`. A file the agent created
after that point is deleted again; a file it changed is put back as it was.

**What it does not restore:** anything a shell command changed. If the agent ran
`npm install`, or `rm`, or a build script, `/rewind` cannot undo it — only the
files written through `edit_file` and `write_file` are backed up. The reminder
is printed every time for that reason. Your own hand edits are not restored
either.

Afterwards `acc` tells the model that the workspace may no longer match the
conversation that survived, so it re-reads a file instead of trusting what an
older turn said about it.

`/rewind` reaches past a summary. If `/compact` replaced part of the
conversation, the messages it replaced are still offered in the picker, marked
`— before the summary`, and picking one brings that conversation back.

## What is not saved

- **Approvals.** Pressing `a` lasts for the run and no longer. A resumed session
  starts asking again. To make an approval permanent, write it as a rule in
  `settings.json`.
- **The permission mode.** `/resume` reopens a conversation, not a
  configuration; a resumed session starts in whatever mode is current.

## Cleaning up

Old sessions are evicted when `acc` starts. A session is deleted only when it is
**both** outside the 50 most recent and older than 30 days, counted across all
your projects together. So a session you have not touched in a year survives if
it is still in your latest fifty, and a busy month does not cost you anything
recent.

Sessions written by a version before the current format are skipped rather than
migrated — neither picker shows them.
