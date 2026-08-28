---
title: Install
description: Clone the repository, link the acc command onto your PATH, and understand what the first screen shows you.
sidebar:
  order: 1
---

`acc` is installed from source: clone it, build it, link it. It is not on the
npm registry yet, so there is no `npm install -g acc`.

## Before you start

- **Node 22 or newer.** Check with `node -v`. Anything older is refused by the
  package itself.
- **ripgrep (`rg`) on your `PATH`.** The `grep` tool shells out to it. Without
  it, `grep` does not crash — it returns `ripgrep (rg) is not on PATH, so grep
  cannot run. Use bash with grep -rn instead.`, and the agent searches with the
  shell instead. That works, but it is slower and it ignores your `.gitignore`.
  Install ripgrep with `brew install ripgrep`, `apt install ripgrep`, or from
  [the ripgrep releases](https://github.com/BurntSushi/ripgrep/releases).
- **An API key** for DeepSeek, GLM, or Kimi. One is enough — see
  [Models](/configure/models).

## Install

```bash
git clone https://github.com/Xuxyyy/terminal-coding-agent.git
cd terminal-coding-agent
npm install
npm link
```

There is no separate build step. `npm install` runs the package's `prepare`
script, which is `tsc`, so the TypeScript is compiled into `dist/` as part of
installing. `npm link` then puts the `acc` command on your `PATH`, pointing at
that build.

## Check it worked

```bash
which acc
```

That should print a path ending in `bin/acc`.

Launched on its own, `acc` takes **no arguments** — the folder you are standing
in is the only input it needs. The one thing it accepts is
[print mode](/start/headless): `acc -p "your task"` runs a single turn without a
terminal and exits, for scripts and pipelines.

There is still no `--help`. Anything else you pass is an error, so `acc --help`
gives you `error: unknown option: --help`, which means the install is fine.

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

[Tools](/configure/tools) describes all five tools and their limits.

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
stops the whole turn, the same as it does anywhere else.

Refusing does not end the task. The agent is told not to retry, and carries on
with the rest of what you asked. Stopping does end it — that is the difference
between `n` and Esc.

[Permissions](/configure/permissions) explains the rule that decides which
actions stop, and [Commands](/configure/commands) covers the keys for
interrupting and leaving. Your conversation is saved as you go, so leaving is
not losing it.

## Keeping it up to date

The link points at your clone, so updating is a pull and a rebuild:

```bash
cd terminal-coding-agent
git pull
npm install
```

## Uninstall

```bash
npm unlink -g terminal-coding-agent
```

That removes the global link. Delete the clone afterwards if you want it gone,
and remove `~/.acc/` to drop your saved sessions and settings with it.
