---
title: Commands
description: Every slash command in acc, what it prints, and how to leave.
sidebar:
  order: 1
---

Type `/` in the input box to open the menu. It filters as you type, ↑↓ moves
through the matches, and enter runs the highlighted one — so `/co` then enter
runs `/context`.

All six commands only work while `acc` is idle — typing one while the agent is
still working does nothing.

## `/context`

*Show token usage.*

Prints how full the context window is right now: a total, a bar, and a breakdown
into system prompt, system tools, messages, and free space.

```
context: 41,208 / 262,144 tokens (16%)
███░░░░░░░░░░░░░░░░░

system prompt          ~1,180
system tools           ~2,940
messages              ~37,088
free                  220,936
```

The total is what your provider measured on the last turn; the parts are
estimates and are marked `~`.

## `/compact`

*Summarize and shrink the conversation.*

Replaces the whole conversation with one summary the model writes. The spinner
reads `Compacting…`, then a notice reports the result:

```
compacted 34 messages, ~28,400 tokens freed
```

If the summary fails, nothing changes and you get
`nothing compacted: the summary failed`.

## `/clear`

*Clear the conversation.*

Throws the conversation away instead of summarizing it. The screen goes back to
the header and prints `context cleared`.

Unlike `/compact`, this also closes the session file — your next message starts a
brand new session. The old one is still on disk and still shows up in `/resume`.

## `/resume`

*Reopen a past conversation.*

Opens a picker of past conversations from the folder you are in, each with its
first task and its age. Enter reopens the chosen one in place and replays its
transcript into the scrollback; esc cancels.

```
Reopen a conversation
❯ fix the failing test in src/parser.ts                    2h
  add a --json flag to the report command                  3d
↑↓ to move · enter to open · esc to cancel
```

If there is nothing to show, it says `No past conversations in this folder yet.`

## `/rewind`

*Go back to before an earlier message.*

Opens a picker with one row per message you sent, newest selected. Choosing one
shows exactly which files will be restored and waits for `enter`:

```
rewind to before "add a --json flag to the report command"
3 files will be restored:
  src/report.ts
  docs/report.md   (deleted — it did not exist yet)
files changed by a shell command or by you are not restored
enter to rewind · esc to cancel
```

Afterwards a notice counts what happened, like
`rewound to before "…" · 3 files restored`.

Rows marked `— before the summary` are messages a `/compact` replaced; picking
one brings that conversation back. If there is nothing to rewind to, it says
`Nothing to rewind yet.`

## `/permission`

*Change what runs without asking.*

Opens a picker of the three permission modes, on the one you are in:

```
Choose what runs without asking
❯ ask-edits — asks before every edit
  auto-edits (current) — edits without asking
  auto — a model decides what would be asked
↑↓ to move · enter to choose · esc to cancel
```

Choosing one prints `switched to auto` and saves it to
`~/.acc/settings.json` for next time. If it could not be saved, the notice says
so: `switched to auto (not saved to settings.json)`.

## Keys and leaving

| Input | What it does |
|---|---|
| **Esc** while working | Stops the model and any running shell command. |
| **Esc** in an approval box | The same as `n` — refuses that one action. |
| **↑ / ↓** in the input box | Walks your previous prompts, saved to `~/.acc/prompt-history` and kept between runs. While the slash menu is open, they move through it instead. |
| `exit`, `quit`, `q` | Closes `acc`. |

These are typed as plain words, not slash commands, and they are not in the
menu.
