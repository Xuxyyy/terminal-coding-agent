# Sessions, resume, and reliability

Status: built.
Covers: `src/core/store.ts`, `src/core/records.ts`, `src/core/projects.ts`,
`src/core/retry.ts`, `src/core/compact.ts`, `src/core/history.ts`, `src/core/rewind.ts`,
`src/ui/restore.ts`,
`src/ui/rewind.ts`, `src/ui/components/SessionPicker.tsx`,
`src/ui/components/RewindConfirm.tsx`, `/resume`, `/rewind`, `/compact`
Read when: changing what a session stores, how `/resume` replays it, rewind, or eviction
See also: `agent-loop.md` (who calls `appendStep`), `permissions.md` (why approvals are
never restored)

Key names, so a search finds this file: `startSession`, `openSession`, `seed`, `appendStep`,
`appendMessage`, `appendView`, `appendCompact`, `messagesOf`, `checkpointsOf`, `lastUsageOf`,
`viewOf`, `restoreView`, `evictSessions`, `captureBefore`, `restorePlan`, `restoreFiles`,
`rewindSession`, `session.jsonl`.

## The rule

**Never throw away work the user has already paid for.** Twenty turns of tool output, a
half-streamed answer, an hour-long session — each is tokens already bought, and each used to be
discarded because something hit a limit or a socket closed.

## The step checkpoint

`MAX_STEPS = 20` exists so a confused model cannot burn money forever. It is a **checkpoint,
not a ceiling**: on reaching it the loop asks through the existing seam.

```ts
const answer = await host.confirm({
  command: 'continue',
  reason: `${step} steps without finishing`,
  suppressible: true,
});
```

`once` runs another 20 turns then asks again, `session` stops asking for the rest of the run,
`deny` stops. Reusing `confirm` rather than adding `Host.onLimit` keeps the seam at three
methods, and it needed no UI work.

## Retry

The SDK's built-in retry covers the request that opens the stream. It cannot cover a failure
after chunks start arriving, because the SDK does not know what the caller already did with
them — and we have already written them to the screen.

> Retry a turn only if nothing has been emitted yet — `content === ''` and no tool call
> deltas have arrived.

If the stream dies after any output, do **not** retry. Emit the error, keep the partial
assistant message in `session.messages`, and let the user decide. Replaying would print the
first half of the answer twice, and the user cannot tell which half is real.

3 attempts, 1s / 2s / 4s backoff, only for connection errors, 429 and 5xx (`retry.ts`). Never
a 400 or a 401 — those are our bug or a bad key, and retrying hides them. The abort path stays
first, so `Esc` still stops instantly.

## What a session stores

```
~/.acc/projects/<basename>-<hash8>/
  project.json                     {"path": "/abs/path/to/workspace"}
  sessions/
    <YYYYMMDD>-<HHMMSS>-<id8>/
      session.json                 metadata only, small, version 2
      session.jsonl                one {kind, …} record per line, append-only
      files/<sha256>               the bytes of a file before a write, if any
```

Six record types interleave in the one file:

| record | written when | holds |
|---|---|---|
| `{kind:'message', id, message}` | a task is sent | the user message alone |
| `{kind:'messages', messages, usage}` | a model turn ends | what that turn added |
| `{kind:'view', items}` | the screen commits | the `Item[]` the terminal drew |
| `{kind:'compact', summary, replaced}` | `/compact` succeeds | the summary, nothing truncated |
| `{kind:'code', path, before}` | a tool is about to write | the path, and the sha of its old bytes |
| `{kind:'rewind', to}` | `/rewind` picks a message | how many records survive the cut |

**Messages feed the model; the view feeds the screen; `code` feeds nothing yet.**
`session.messages` is exactly what the API needs to continue, so resume is right by
construction. The view exists because the diff
never enters `messages` — an edit would replay as `Edited 'src/cart.js'.` instead of red and
green lines. Timing, retries and errors are still not stored; that is debugging information, and
a debugging transcript is a separate feature with a different lifetime.

The user message is written *before* the task item it drew, so a rewind can cut at one line and
take the screen with it, and a turn killed before the first `save()` still records what you
asked. Each `message` record carries an 8-hex `id`, which is what the rewind picker looks up.

**The system prompt is not stored.** It is rebuilt by `systemPrompt()` on every run, and resume
skips the stored copy anyway, so keeping it only bought a duplicate in every session.

**A reader must ignore any record kind it does not know.** That is what lets new kinds be added
with no migration. A version 1 session is skipped rather than migrated — `loadSession` and the
picker do not see it, but `evictSessions` still does, or old folders would leak forever.

Three properties of this layout:

1. **Grouped by project.** "Do not resume another folder's session" is structural rather than a
   check someone must remember to write. A session whose `workspace` is not the current
   directory is refused.
2. **Append-only.** `fs.appendFileSync` is the only writer; nothing rewrites the file, not even
   a rewind. At turn 80 with file contents in the history, a rewrite-every-turn design moves
   megabytes each turn and corrupts the whole conversation if it crashes mid-write. JSONL has no
   growing array to rewrite.
3. **Cheap listing.** `session.json` is a few hundred bytes, so the picker reads small metadata
   files instead of parsing large ones.

`ACC_HOME` is the root, not `os.homedir()` directly — it is the existing convention and it lets
tests point at a temp folder. Files are `0600` and directories `0700`: the conversation contains
the contents of every file the agent read and the output of every command it ran, so a config
with a password in it is now on disk in plain JSON.

Writing is best-effort. If a write fails, warn once and keep going — losing the ability to
resume must never kill a working run.

**`allowed` is stored nowhere.** A permission granted an hour ago must not be waiting after a
restart.

**`asked` and `denied` follow the same rule.** Both live on `Session` beside `allowed`, are
never written to disk, and are emptied by `/clear`. They are the judge's authorization context
in `auto` mode — every user message, and the commands the user pressed `n` on. `asked` is
rebuilt from the restored user messages on `/resume` and `/rewind`, so the judge's view of what
was authorized travels with the conversation; `denied` is not, because a refusal belongs to the
run it happened in. See `permissions.md`, *The judge*.

## Every reader cuts at the same place

Every read goes through `liveRecords` first. It folds the log left and, at each `rewind` record,
trims the list back to `to` — so `to` always indexes the list *as it stood then*, and two rewinds
in a row compose with no special case. What the four readers below see is the live list; the
records a rewind dropped are still in the file and are never handed to them.

Two readers restart at a `compact` record; the other two deliberately do not.

| reader | at a compact record |
|---|---|
| `messagesOf` | drops everything before it; the summary becomes the first message |
| `lastUsageOf` | stops the backward scan and returns `null` |
| `checkpointsOf` | **unchanged** — every user message stays reachable, the compacted ones too |
| `viewOf` | **unchanged** — the scrollback is a transcript of what was drawn |

That `messagesOf` restarts and `checkpointsOf` does not is what lets a rewind cross a summary,
and the two must stay disagreeing. The picker offers a message the summary replaced; cutting at
that record drops the `compact` record out of the live list, and `messagesOf` — which resets only
when it still sees one — rebuilds the whole pre-compaction conversation with no special case.

`lastUsageOf` restarts for a different reason. Resume sets `lastContextTokens` from it, so a
session compacted and then reopened would report the size of the conversation that was just
thrown away, and report it as measured — a confidently wrong number, worse than an estimate.

`viewOf` stays whole on purpose: after a compaction the screen still shows the conversation you
had, because you did have it. Only the model forgot.

## `/resume`

A picker listing past conversations by their first task. It reopens a session **in place** —
`openSession` plus `store.seed(session.messages)` — which is what stops the history being
copied into a new folder. Seed the live array, not the stored one; the fresh system message is
a different object.

The whole stored view is replayed, led by one summary line (`restored 42 messages from
2026-08-11 10:04`). ink's `Static` prints each row once into terminal scrollback, so a long
replay costs one render and stays scrollable. When a session has no view records,
`restoreItems` maps the messages instead, and tool results come back with `diff: null`.

## `/rewind`

The same picker, one row per user message, newest selected, dropping the conversation from that
message onward and putting back every file the agent wrote after it. Rows older than the last
summary say so. On disk it **appends a marker** rather than cutting: `store.rewind(to)` writes
`{kind:'rewind', to}` and the dropped records stay where they are. Readers resolve the marker,
so every consumer sees the short history while the file keeps the long one.

A `parentUuid` tree would keep several branches live at once, and it would make every reader —
`loadSession`, `restoreView`, the picker, eviction — learn that the file is a forest. The picker
only ever offers one line of history, so the marker buys the property that matters (nothing is
destroyed) at the cost of one fold.

The order is **files, then store, then memory, then screen**, and all of it lives in one core
function — `rewindSession(store, session, at)` in `src/core/rewind.ts`. It runs `restoreFiles(…)`,
`store.rewind(at)`, then reads the log back and rebuilds both the conversation and the view from
what survived: `restoreMessages(session, messagesOf(after))`, `setMeasured(…)`, and `viewOf(after)`
handed back as `kept`. The hook keeps only the screen state around that one call — it commits the
notice and sets the returned items. The split exists because every other command already keeps its
work in core, and a core function can be tested without starting a terminal. Core throws and
catches nothing; the hook decides what the user sees, so a failed disk write leaves memory and disk
still agreeing and the rewind is abandoned with a notice. Rebuilding, rather than slicing
`session.messages`, is what makes the three views agree after a compaction, where memory holds two
messages and the log holds twenty.

The marker goes **after** the files because it is the irreversible step: once it lands, the `code`
records above the cut fall out of the live fold and their copies can never be reached again.
Restoring first is idempotent — writing the same old bytes twice is the same result — so a crash
between the two is safe to repeat.

**A rewind that changes files asks first.** `rewind(id)` builds `rewindPlan(store, cut.at)` and,
when it is not empty, shows `RewindConfirm` with the paths, the ones marked `(deleted — it did not
exist yet)`, and the line that shell-command changes are not restored. `applyRewind(id)` is the
half that writes; `cancelRewind()` writes nothing at all. An empty plan skips the screen entirely
and rewinds as it always did — a prompt that says "0 files" is noise. The notice afterwards carries
the counts: `rewound to before "fix the cart" · 2 files restored, 1 deleted`, plus `· 1 file had no
saved copy` when a copy was missing.

**The model is told the workspace may have moved on.** `rewindSession` ends by pushing
`REWIND_NOTE` — one user message saying earlier turns were removed, that what they say about a
file may be out of date, and that it should be read from disk before being relied on. The confirm
screen warns *you*, before; nothing warned the model, after. Without it a stale belief survives the
cut: the turns that created a file can sit above the cut while the `bash` command that deleted it
sits below, and `>>` on a missing file succeeds silently, so the agent reports success on a file
that no longer matches.

**It distrusts the state, not the goal.** The note closes by saying what those turns asked for
still stands. An earlier wording stopped at "before relying on anything above about what it
contains", and the model read that as license to discard the surviving request too: told to append
a line to a file the rewind had removed, it wrote a file holding only that line and dropped the
three the session had already built. Messages above the cut are real history; only the workspace is
in doubt. A rewording must not widen the doubt back onto the request.

The note does not name paths. Naming them would mean re-deriving write targets from the dropped
commands, and the agent can find them itself once it knows to look — a nudge to read is the whole job.

The note is **live-only**: it goes into `session.messages` *before* `store.seed`, which marks it
written, so it never reaches `session.jsonl` and does not survive `/resume`. Persisting it has no
cheap home. Its own `messages` record would make `lastUsageOf` read the note's usage instead of
the turn's, and `appendMessage` would give it a checkpoint id and a row in the rewind picker. A
resumed session is a fresh read of the workspace anyway, so the belief it corrects is weakest
exactly where the note is missing.

**The context reading survives too.** `restoreMessages` sets `lastContextTokens = 0`, so the caller
overrides it with `setMeasured(session, lastUsageOf(after)?.total ?? 0)` — the same line `/resume`
runs. `lastUsageOf` stops at a `compact` record, so a rewind that crosses a summary finds the real
pre-compaction total (a request whose prompt was exactly the restored conversation), and one that
lands *after* a surviving summary gets `null` and correctly falls back to the estimate. A rewind to
the **very first** message is the same story from the other end: the cut leaves no records at all,
so there is nothing to restore and `/context` estimates the system prompt and the tools — which is
the only honest number for a conversation with no messages in it. The helper keeps its `0`, because
`clearSession` calls it too and `/clear` must measure nothing.

**The rebuilt messages must be seeded back into the store** — `store.seed(session.messages)`.
They are fresh objects parsed from JSON, so they are not in the `written` set, and without the
seed the next `appendStep` writes every one of them to the log a second time. `/resume` does the
same thing for the same reason.

The picker has no store to read from until the first message is sent, and then the rows come
from the records alone — one row per `message` record. A row carries that record's 8-hex id and
its line index; the id is what `rewind` looks up, because an index into `session.messages` would
not survive the rebuild. A session whose store failed to open shows an empty picker: it cannot
resume either, and one code path is worth more than a second way to rewind.

Two things a rewind does **not** do: clear `allowed` (the approvals were granted in this run —
the opposite of `/clear`, deliberately) or roll back `usage` (you did spend those tokens).

**A rewind crosses a compaction.** The rows reach every user message in the session, including
the ones a summary replaced, and picking one of those brings the original conversation back —
the `compact` record falls out of the live list, so nothing replays the summary. Those rows are
marked ` — before the summary`, because they are a different size of jump from the row above
them. Landing on the message just before a summary restores the context that triggered the
compaction, so the next turn compacts again; that is correct, and the normal case — a row
further back — restores a small context and nothing fires.

There is no `/uncompact`. Crossing a summary happens as part of an ordinary rewind or not at all;
an undo button for compaction alone is a different command with a different meaning.

**A preview of what is about to go is not possible** in the scrollback. `HistoryList` prints
committed rows through ink's `Static`, which writes each row into terminal scrollback exactly
once; already-printed lines cannot be dimmed or removed. Worth knowing before someone tries to
build it. The picker also shows no token estimate — there the number would stand alone with
nothing measured beside it, and a `~` number that is only roughly right invites a decision based
on it. `/context` does print estimates, because there they sit next to a measured total, every
estimated number is marked, and nothing acts on them.

## Retention

On startup, delete sessions older than **30 days**, keeping the most recent **50** regardless of
age (`SESSION_MAX_AGE_DAYS`, `SESSION_KEEP`). Sessions carry file contents, so a store with no
eviction is a fast leak, not a slow one.

## Compaction

`/compact` asks the model to summarize the conversation, then replaces `session.messages` with
`[system, one assistant message]`. `compactSession` has two callers — `/compact` at the prompt,
and turn 0 of a run when the session is over the threshold. Why never mid-run, and how the two
relate to clearing, is `agent-loop.md`.

**The whole conversation goes, not the oldest half.** Keeping the last N turns means choosing a
cut point, and the wrong cut lands between an assistant message carrying `tool_calls` and the
`tool` messages answering it, which makes the next request invalid. Replacing everything cannot
produce that shape.

The summary is an `assistant` message, not a `user` one: the model wrote it, and it keeps the
`system → assistant → user` order, so no provider ever sees two user messages in a row. It sits
behind a fixed `SUMMARY_PREFIX` so the model reads it as context rather than as an answer it
already gave. The summarizing request sends **no tool definitions** — that saves the ~526 tokens
they cost and stops the model calling a tool when all it must do is write prose.

A failed or empty summary changes nothing and returns `null`. A compaction that half-runs would
destroy the conversation it was meant to shrink.

**The summary must enter the store's `written` set.** `appendCompact` takes the assistant
*message object*, not the string. Without that, `appendStep` — which `loop.ts` hands the whole
of `session.messages` — sees a message it has no record of and writes it a second time as a
`messages` record, so `messagesOf` replays the summary twice. It only shows up once a real turn
follows the compaction, which is why a test covers exactly that order.

**What `measured` means afterwards.** `compactSession` sets `lastContextTokens = 0`, exactly as
`restoreMessages` does, because that request's prompt was the *old* conversation — it measures what was
thrown away, not what remains. `/context` falls back to the estimate, which runs ~28% low, so
the number right after a compaction is the least trustworthy one in the app. Once one real turn
has run on top, `lastUsageOf` finds it and the reading is measured again, against the new
conversation.

## File versions

Every write copies the **old** bytes into the session first, and `/rewind` reads them back.
Pointers in the stream, bytes outside it:

```
sessions/<id>/session.jsonl     {"kind":"code","path":"src/core/retry.ts","before":"8f467a51…"}
sessions/<id>/files/8f467a51…   the whole file, not a diff
```

Copies are full files. A patch format would have to be applied in order and would fail on any
file the tracker missed. `path` is workspace-relative, so it survives the workspace folder being
moved. `before` is the sha256 of the copy, or `null` when the file did not exist — which the
restore reads as *delete this file*, the only way creating a file can be undone.

**One record per write, appended in place — not one snapshot map per checkpoint.** A map written
at the checkpoint cannot be filled in when the checkpoint happens: the version that restores
message N is the copy taken by the first write *after* N, which does not exist yet, so every map
would have to be rewritten later. A per-write record needs no back-fill, and the record's
**position in the log** is already the link to the message above it.

**The copy is taken after the approval and before the write.** Copying after the write stores
content that undoes nothing; copying before the approval stores bytes for writes the user
denied. `permitted()` returning clean, in `registry.ts`, is the one moment that is neither — it
already runs before every write and already receives `{kind: 'write', path}`. The gate calls the
hook, not the two writing tools, so a third tool cannot forget it. Only written files are
copied, never read ones.

**Content-addressed by sha256, one copy per distinct content.** A file written forty times with
the same bytes costs one copy, and the write is idempotent: if `files/<sha>` exists, skip it.

**A missing copy is normal, not corruption.** A capture failure — disk full, an unreadable file
— skips the copy, appends no record, and lets the write proceed. Failing the tool because a
backup failed would be worse than the dangling record it avoids, so the restore treats a
record it cannot find bytes for as *conversation only* and counts it as skipped.

**The version that restores checkpoint C is the earliest copy above C, not the newest.** Two
edits to the same file, in log order:

```
0  message  "fix the cart"
1  code     note.txt  before=A     ← A is the original
2  messages
3  message  "and the total"
4  code     note.txt  before=B     ← B is what the first edit produced
5  messages
```

Rewinding to record 3 restores B: the file as it stood when that message was sent. Rewinding to
record 0 restores A. Taking the *newest* copy above the cut would restore B in both cases and
silently leave the first edit in place. Read per path, earliest wins — `restorePlan` walks from
the cut to the end and keeps the **first** entry it sees for each path.

`restoreFiles` applies that plan and returns `{restored, deleted, skipped}`. A `before` that is a
sha is read out of `files/<sha>` and written back, parents created with `fs.mkdirSync` and the
umask — **not** `makeDir`, whose `0o700` is right for the session folder and wrong for a directory
in the user's project. A `before` of `null` deletes the file, and deleting one that is already
gone still counts as `deleted`: the end state is what was asked for, and `bash` may have removed
it in between. A missing copy, or anything that throws for one path, is counted as `skipped` and
never stops the rest — capture is allowed to fail silently, so a record with no bytes behind it
is a designed state, not corruption.

Eviction needs nothing: `files/` is inside the session folder, and `evictSessions` already
removes that folder recursively.

Two questions the restore has **not** answered:

- `bash` is not captured and not restored, and the confirm says so every time, without detecting
  anything. `classify.ts` resolves redirect targets and `cp/mv/rm` arguments, but never `sed -i`,
  `npm run build`, or `node -e`; partial capture would yield a half-restored tree, which is worse
  than a boundary the user can see. Claude Code draws the identical line: across 118 sessions of
  this project, 1277 `Bash` calls that write, and `file-history-snapshot` backed up none of them.
  Detecting *whether* bash ran was rejected too — a quiet run is not proof nothing was written.
- A byte cap. There is none today, deliberately: a cap adds a third state to the record —
  *skipped*, neither a sha nor `null` — that the restore would have to handle, and the number to
  set it at should come from measured sessions, not a guess.

A git-backed snapshot would answer the first one properly, because it inspects the tree afterwards
instead of predicting beforehand. It is also a new dependency — `src/core/` never spawns git — and
it would replace this storage rather than extend it. Judge it on real use, in its own plan.

## A note on prose that states a rule

`PERMISSION_LABEL` in `ui/agent.ts` states the permission rule in words and has drifted from the
code once already. Anything that restates a rule in prose will drift again; if modes arrive, the
label must come from the same place the decision does.
