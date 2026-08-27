---
title: Trade-offs
description: Three features that are cheap to add and expensive to add wrong — a git-backed snapshot, a byte cap on stored file copies, and compact-and-retry — and what each one is waiting for.
sidebar:
  order: 2
---

This is the page I would want to read about someone else's project, so it is the
one page here written in the first person.

Everything below is something I could build in an afternoon. None of it is
blocked on difficulty. Each one is held back for the same reason, which I think
is the more interesting thing to say about a small project than a roadmap would
be: **each is cheap to add and expensive to add wrong, and none of them has a
number behind it yet.**

The failure mode I am avoiding is the one where a half-right safety feature is
worse than none. A restore that puts back most of your files, a cap that
silently skips the file you needed, a retry that fires on the wrong error — each
of those is trusted by the user exactly as much as a correct one, right up to
the moment it matters.

## A git-backed snapshot

**What it would do.** `/rewind` puts back every file the agent wrote after the
message you rewind to. It does that by storing a copy of each file's bytes
before a write, keyed by the write. That works perfectly for `edit_file` and
`write_file`, and not at all for `bash` — a `sed -i`, an `npm run build`, or a
`node -e` changes the tree without going through a file tool, so nothing is
stored and nothing comes back.

The confirm prompt says so, every time, rather than detecting anything.

**Why I have not built it.** The version I could ship this week is *partial
capture*: teach the classifier to spot a few more write-shaped commands and back
those up. That is the wrong shape. Partial capture yields a half-restored tree,
which is worse than a boundary you can see — you would rewind, get most of your
files back, and have no way to know which ones were missed.

I also rejected the cheaper trick of detecting merely *whether* `bash` ran and
warning louder. A quiet run is not proof nothing was written.

The right version inspects the working tree *afterwards* rather than predicting
beforehand, which means git. That is a real dependency — `src/core` never spawns
git today — and it would **replace** the current storage rather than extend it.
That is a rewrite of the restore path, and I want to judge it against real
sessions rather than my guess about them. It belongs in its own plan.

Worth noting: this is not an unusual line to draw. Claude Code draws the same
one. Across 118 sessions of this project there were 1,277 `Bash` calls that
wrote to disk, and its file-history snapshot backed up none of them.

## A byte cap on stored file copies

**What it would do.** Every write stores the file's old bytes so `/rewind` can
put them back. There is no size limit on that, so a run that rewrites a large
generated file a few times stores it a few times.

**Why I have not built it.** A cap sounds like one line and is not. It adds a
third state to the record: today a stored copy is either a hash or `null`, and a
cap introduces *skipped* — present, deliberately not stored — which every reader
of the restore path then has to handle, and handle differently from "there was
nothing to store."

That is fine, if the number is right. But the number should come from measured
sessions — what people actually write, how large, how often — and I do not have
that measurement yet. Picking a limit now means picking it from imagination, and
then living with a third state I added to enforce a guess.

## Compact-and-retry on a length rejection

**What it would do.** When the conversation gets long, `acc` clears recoverable
tool results mid-turn and compacts at a turn boundary, both triggered well below
the window. If all of that somehow fails to keep up, the provider rejects the
request for length and the run stops with a message. Compact-and-retry would
catch that rejection, summarize, and try once more — the safety net under the
trigger rather than the trigger itself.

**Why I have not built it.** The error shape differs per provider. There is no
shared status code and no shared wording for "your context is too long"; each
one says it differently, and some say it the same way they say other things.

Which means I cannot write this without seeing the real error from each provider
I support — and the only way to see it is to **pay for a deliberate failure**,
several times over, once per provider. That is a cost I am willing to pay when
the net is needed. It is not needed yet: the trigger fires at 80% of the window,
and in real use nothing has reached the floor.

Writing a retry against an error I have guessed the shape of would give me a
safety net that looks present in the code and is not present in fact. I would
rather have the honest failure message.

## What these have in common

None of the three is hard. All three are held back by the same missing thing: a
number, or an error string, that only real use produces. Building them now would
mean encoding a guess into a place where a guess is invisible — and the whole
point of the permission and restore design is that the user can see exactly
where the boundary is.

## Full reasoning

- [`docs/features.md`](https://github.com/Xuxyyy/coding-cli/blob/main/docs/features.md)
  — what ships today, and the full "not built" list including the sandbox,
  network tools, and a debugging transcript.
