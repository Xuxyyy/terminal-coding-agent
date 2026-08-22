---
title: Permissions
description: When acc stops to ask, what pressing a remembers, and the three permission modes.
sidebar:
  order: 1
---

Every action the agent takes passes through one gate. Most of them run without
bothering you. The ones that stop and ask are the ones you could not take back.

## The prompt

```
⚠ Command approval required
rm -rf build
deletes 'build', which cannot be undone
y approve once · a allow for this session · n deny
```

- **`y`** runs it this once. You will be asked again next time.
- **`a`** runs it and stops asking about that same command for the rest of the
  session. It is forgotten when `acc` closes.
- **`n`** refuses it. Esc does the same thing.

`a` is not always offered. When it is missing, the action is one that can never
be remembered, and one-time approval is the only way through.

Refusing is not an interrupt. The agent is told the command was refused, not to
retry it, and not to look for another way to do the same thing. It carries on
with the rest of the task and tells you at the end what it could not do.

## What decides it

The line is **not** "shell commands ask, file edits don't". It is *what git can
undo* versus what it cannot.

| What the action does | What happens | Offers `a`? |
|---|---|---|
| Reads a file inside the project | runs | — |
| Writes a file inside the project | runs | — |
| Runs `npm`/`pnpm`/`yarn` with `test` or `run` | runs | — |
| Writes to a protected path, like `.git/` | asks | yes |
| Deletes — `rm`, `rmdir`, `find -delete` | asks | yes |
| Anything reaching outside the project | asks | **no** |
| An escape — `sudo`, `git push`, `dd of=`, `mkfs`, a fork bomb | asks | **no** |
| A command it cannot make sense of | asks | yes |

Writing a file with `write_file` and writing it with `echo x > file` get the
same answer, because they do the same thing.

The last two rows never offer `a`, and no setting can silence them. Approving
`git push` once does not approve the next one, and a rule that allows everything
still does not reach past them. That is the price of those doors opening at all.

Anything `acc` cannot parse **asks** rather than runs.

## The three modes

A mode moves where that line sits, and what happens above it.

| Mode | Runs without asking | Above that line |
|---|---|---|
| `ask-edits` | reads only | asks you |
| `auto-edits` | reads and writes inside the project | asks you |
| `auto` | reads and writes inside the project | asks a model |

`auto-edits` is where a session starts.

`auto` is `auto-edits` with a second opinion: everything it would have asked you
about goes to a model first, which answers in one word. `ALLOW` and the command
runs silently; anything else and you get the same box you would have got anyway.
The model can never refuse something on its own, and it never sees an action you
already wrote a rule about.

**No mode refuses anything by itself.** Above its line a mode asks or delegates,
and that is all a mode can do. If you want `acc` to be unable to do something,
write it as a rule instead — that names paths, which a mode never can.

## Switching mode

Type `/permission`:

```
Choose what runs without asking
❯ ask-edits — asks before every edit
  auto-edits (current) — edits without asking
  auto — a model decides what would be asked
↑↓ to move · enter to choose · esc to cancel
```

The picker opens on the mode you are in. Choosing one prints
`switched to auto` and takes effect from your next message. The conversation is
not disturbed.

The choice is written to `permission_mode` in `~/.acc/settings.json`, so the
next run starts there too. If that file cannot be parsed, the switch still
applies to the running session and the notice says
`switched to auto (not saved to settings.json)`.

**The header keeps showing the mode you left.** After switching, the
`permissions:` line at the top of the screen still reads the old name. This is a
display bug, not a failed switch — the notice under the picker is what tells you
it worked, and reopening `/permission` shows the new mode marked `(current)`.

## Writing it down instead

Approving the same command every session gets old. A settings file makes it
permanent:

```json
{
  "permissions": {
    "allow": ["bash(npm run *)"]
  }
}
```

Rules are read before anything else decides, so a command you approved by hand
stops asking on every restart. They can also make `acc` stricter than any mode.

[Settings](/reference/settings) is the full reference: where the files live, the
pattern syntax for `bash(...)` and `edit(...)`, and which rule wins when two
match.
