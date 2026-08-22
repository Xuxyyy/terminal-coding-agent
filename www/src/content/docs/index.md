---
title: acc
description: A small terminal coding agent that reads, edits, and runs code in the current directory.
---

`acc` is a coding agent that lives in your terminal. You start it inside a
project, describe a task in plain English, and it reads the files, searches
them, edits them, and runs commands until the task is done — asking you first
before anything it cannot take back.

## Quick start

```bash
git clone https://github.com/Xuxyyy/coding-cli.git
cd coding-cli && npm install && npm link
```

Then go to the project you want to work on and start:

```bash
cd ~/code/my-project
acc
```

The folder you are in **is** the workspace. `acc` reads and writes there and
nowhere else, so start it in the project you mean.

You will need Node 22 or newer, [ripgrep](https://github.com/BurntSushi/ripgrep)
on your `PATH`, and one API key.

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

## Where to go next

Install it, pick a model, then run it on something small.
