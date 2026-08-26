---
title: Commands
description: Every slash command in acc, what it prints, and how to leave.
sidebar:
  order: 1
---

Type `/` in the input box to open the menu. It filters as you type, ↑↓ moves
through the matches, and enter runs the highlighted one — so `/co` then enter
runs `/context`.

All eight commands only work while `acc` is idle — typing one while the agent is
still working does nothing.

| Command | What it does |
|---|---|
| [`/context`](#context) | Shows how full the context window is, broken into system prompt, tools, messages, and free space. |
| [`/compact`](#compact) | Replaces the conversation with a summary the model writes, and reports what it freed. |
| [`/clear`](#clear) | Throws the conversation away and closes the session file, so the next message starts a new one. |
| [`/resume`](#resume) | Picks a past conversation from this folder and reopens it in place. |
| [`/rewind`](#rewind) | Goes back to before one of your earlier messages, restoring the files the agent wrote. |
| [`/permission`](#permission) | Switches between the three permission modes and saves the choice for next time. |
| [`/model`](#model) | Switches which model answers, keeping the conversation as it is. |
| [`/mcp`](#mcp) | Lists the MCP servers from your settings file and whether each one connected. |

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

- **system prompt** — the instructions `acc` sends every turn, including a
  description of your project.
- **system tools** — the definitions of the tools the model is offered: the
  five built-ins, plus any an MCP server added.
- **messages** — everything you and the model have said, plus every file read
  and every command's output.
- **free** — what is left.

The total on the first line is the number your provider actually charged on the
last turn. The four parts underneath are **estimated** from character count,
which is why they carry a `~`. They always add up to the total exactly. Before
the first model reply there is nothing measured yet, so the total is an estimate
too and gets its own `~`.

### As the window fills

`acc` manages the window on its own, in three steps, and only the last two are
visible.

**First it clears quietly.** Past 80% it drops the *contents* of old tool
results it can get back — a file it read becomes
`[file contents cleared; read the file again if needed]`, a search becomes
`[search results cleared; run the same grep again if needed]`, and a shell
command keeps its `[exit 0]` line but loses its output. The most recent round of
tool calls is never touched, so work in progress is safe.

**Then it says so.** When clearing cannot free anything more, it prints one line
and keeps going:

```
compaction threshold reached
```

**Then it compacts by itself.** At the start of your next message, if the
conversation is still over the line, `acc` replaces it with a summary before
sending. The spinner reads `Compacting…`, and your message is held aside and
sent straight after, so nothing is lost.

If none of that is enough — the next request plus room for a 32,000-token reply
would not fit — the turn stops rather than sending something the provider will
refuse:

```
stopped: the context is full and nothing more can be freed; send your next message and it will compact first
```

The 80% line is the default and `ACC_COMPACT_AT` moves it — see
[Settings and models](/reference/settings).

## `/compact`

*Summarize and shrink the conversation.*

Replaces the whole conversation with one summary the model writes. The spinner
reads `Compacting…`, then a notice reports the result:

```
compacted 34 messages, ~28,400 tokens freed
```

If the summary fails, nothing changes and you get
`nothing compacted: the summary failed`.

The summary keeps what the conversation decided and drops the transcript that
got there. Use it when you are about to start a big new task in a session that
has been running a while. `/rewind` still reaches past a summary — messages a
summary replaced stay in its picker.

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

Sessions live in `~/.acc/projects/<folder-name>-<hash>/sessions/<id>/`. The
project folder is named after the directory you ran `acc` in plus a short hash
of its full path, so two projects with the same name never collide. Files are
created readable only by you, and `ACC_HOME` moves all of it somewhere else.

**Two things are not saved.** Approvals last for the run and no longer, so a
resumed session starts asking again — to make one permanent, write it as a rule
in [Settings and models](/reference/settings). And the permission mode is not
restored either: `/resume` reopens a conversation, not a configuration.

Old sessions are evicted when `acc` starts. One is deleted only when it is
**both** outside the 50 most recent and older than 30 days, counted across all
your projects together.

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

Files changed by a shell command, or by you in your editor, are not restored —
only writes that went through `edit_file` or `write_file`.
[What I left out, and why](/design/tradeoffs) explains that boundary.

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
The choice takes effect from your next message and the conversation is not
disturbed.

| Mode | Runs without asking | Above that line |
|---|---|---|
| `ask-edits` | reads only | asks you |
| `auto-edits` | reads and writes inside the project | asks you |
| `auto` | reads and writes inside the project | asks a model |

`auto-edits` is where a session starts. **No mode refuses anything by itself** —
above its line a mode asks or delegates, and that is all a mode can do. To make
`acc` unable to do something, write a `deny` rule instead, which names paths.
[The permission gate](/design/permissions) is the reasoning behind the line.

**The header keeps showing the mode you left.** After switching, the
`permissions:` line at the top of the screen still reads the old name. This is a
display bug, not a failed switch — the notice under the picker is what tells you
it worked, and reopening `/permission` shows the new mode marked `(current)`.

## `/model`

*Switch the model.*

Opens a picker of all six models, in registry order, on the one you are using:

```
Choose a model
  Kimi K3 — needs MOONSHOT_API_KEY
  Kimi K2.7 Code — needs MOONSHOT_API_KEY
  DeepSeek v4 Pro — deepseek-v4-pro
❯ DeepSeek v4 Flash (current) — deepseek-v4-flash
  GLM 5.2 — needs GLM_API_KEY
↑↓ to move · enter to choose · esc to cancel
```

A model whose provider key is not set is shown rather than hidden, so you can
see it is there and read which variable it wants. Such a row stays grey when you
move onto it, `enter` does nothing, and the hint line becomes
`set GLM_API_KEY to use this model`.

Choosing one prints `switched to GLM 5.2`, draws a divider across the
transcript where the change happened, and saves the id to `~/.acc/settings.json`
for next time. If it could not be saved, the notice says so:
`switched to GLM 5.2 (not saved to settings.json)`.

The conversation carries over untouched — only the client changes. Earlier rows
keep naming the model that answered them, and the new one picks up the context
budget of its own window. [Settings and models](/reference/settings) lists the six.

## `/mcp`

*Show the MCP servers.*

Lists every server in the `mcpServers` block of your `~/.acc/settings.json` and
what happened when `acc` tried to start it.

```
github — ready, 12 tools
linear — failed: spawn linear-mcp ENOENT
```

A **ready** server is connected and its tools are already offered to the model,
named `mcp__github__list_issues` and so on. A **failed** one is skipped: its
reason is whatever went wrong — the command was not found, it did not speak MCP,
or it did not answer within fifteen seconds — and the other servers keep their
tools. One bad server never stops `acc` from starting.

With no servers configured it says so and names the file to add them to:

```
no MCP servers configured — add an "mcpServers" block to /Users/you/.acc/settings.json
```

Servers connect once, at startup. Editing the block while `acc` is running
changes nothing until you restart — the same rule the
[settings files](/reference/settings) follow. `/mcp` reports what the *current*
run connected to.

## Keys and leaving

| Input | What it does |
|---|---|
| **Esc** while working | Stops the model and any running shell command. |
| **Esc** in an approval box | The same as `n` — refuses that one action. |
| **↑ / ↓** in the input box | Walks your previous prompts, saved to `~/.acc/prompt-history` and kept between runs. While the slash menu is open, they move through it instead. |
| `exit`, `quit`, `q` | Closes `acc`. |

These are typed as plain words, not slash commands, and they are not in the
menu.
