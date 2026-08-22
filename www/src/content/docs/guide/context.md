---
title: Context
description: What fills the context window, how to read /context, and what acc does on its own when the conversation gets long.
sidebar:
  order: 3
---

Everything the model can see at once — the instructions, the tool list, and
every message and file it has read so far — has to fit in one budget called the
**context window**. For most models `acc` supports that is 262,144 tokens.

The window does not grow. A long conversation, or a few large files, will fill
it, and `acc` has to make room.

## `/context` — what is in there

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
- **system tools** — the definitions of the five tools.
- **messages** — everything you and the model have said, plus every file read
  and every command's output.
- **free** — what is left.

The total on the first line is the number your provider actually charged on the
last turn. The four parts underneath are **estimated** from character count,
which is why they carry a `~`. They always add up to the total exactly.

Before the first model reply there is nothing measured yet, so the total is an
estimate too and gets its own `~`.

## When it gets full

`acc` watches the window and works in three steps as it fills up.

**First, it clears quietly.** Past 80% it drops the *contents* of old tool
results it can get back — a file it read becomes
`[file contents cleared; read the file again if needed]`, a search becomes
`[search results cleared; run the same grep again if needed]`, and a shell
command keeps its `[exit 0]` line but loses its output. The most recent round of
tool calls is never touched, so the work in progress is safe. This happens
silently; you will not see a message.

**Then it says so.** When clearing cannot free anything more, it prints one line
and keeps going:

```
compaction threshold reached
```

**Then it compacts by itself.** At the start of your next message, if the
conversation is still over the line, `acc` replaces it with a summary before
sending. The spinner reads `Compacting…` while that happens, and your message is
held aside and sent straight after, so nothing is lost.

If none of that is enough — the next request plus room for a 32,000-token reply
would not fit — the turn stops rather than sending something the provider will
refuse:

```
stopped: the context is full and nothing more can be freed; send your next message and it will compact first
```

Send your next message and it will compact first, as it says.

## `/compact` — do it yourself

`/compact` replaces the whole conversation with one summary the model writes,
right now, instead of waiting for the threshold. The spinner reads
`Compacting…`, then a notice says what it cost:

```
compacted 34 messages, ~28,400 tokens freed
```

The summary keeps what the conversation decided and drops the transcript that
got there. If it fails, nothing changes and you get
`nothing compacted: the summary failed`.

Use it when you are about to start a big new task in a session that has been
running a while. You can also go the other way and start clean with `/clear`,
which throws the conversation away instead of summarizing it.

`/rewind` still reaches past a summary — messages a summary replaced stay in the
picker.

## `ACC_COMPACT_AT`

The 80% line is the default. Set `ACC_COMPACT_AT` to move it:

```bash
ACC_COMPACT_AT=0.6 acc
```

It is accepted only as a number greater than 0 and no greater than 1. Anything
else is ignored and 0.8 is used.
