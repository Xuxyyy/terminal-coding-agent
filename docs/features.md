# What `acc` can do today

Status: v4, 2026-08-17. A list of shipped features, not a design doc.
Read when: you want to know what exists before planning what is next.
See also: `agent-loop.md`, `permissions.md`, `sessions.md` for *why* each part
looks the way it does.

## Shape

One TypeScript package, ~4,000 lines. `src/core` runs the agent and never
imports React; `src/ui` draws it with Ink. The two meet at one seam, the `Host`
interface (`confirm`, `onEvent`, `signal`). 438 tests, all passing.

The workspace is the current directory. Installed as the `acc` command.

## The agent loop

- Streaming turn loop: messages → model → tool calls → run → append → repeat.
- Four tools: `read_file`, `edit_file` (unique-match), `write_file`, `bash`.
- Every tool caps its own output, so no single call can outrun the compaction
  trigger. `bash` keeps 10,000 chars of head and 20,000 of tail, because a
  command's verdict is usually at the end. `read_file` keeps 32,000 chars of
  **head only**, on whole lines, and appends `... [truncated N chars, cap is
  32000; re-read with offset]`. A file is read from the top and its line numbers
  must stay contiguous, so a kept tail would produce a numbered listing with an
  invisible gap; the marker names the cap so the model re-reads with an `offset`
  instead of concluding the file ended. Before this cap, `limit` had a minimum
  and no maximum, and one call could return roughly 128,000 tokens.
- `edit_file` and `write_file` return a diff, drawn in the scrollback.
- Every path is confined to the workspace root before a tool runs.
- Broken tool-call JSON comes back as a tool error, not a crash.
- Esc aborts the model request and any running command.
- System prompt carries an environment block: cwd, OS, git, file tree.

## Models

OpenAI-compatible client, so three providers work through one code path:
DeepSeek, GLM, and Kimi (six model ids). Default is DeepSeek v4 Flash. Keys
load from `.env` files, including `~/.acc/.env`.

Three environment variables change what the client does: `ACC_MODEL` picks the
model id, `ACC_HOME` moves the session store off `~/.acc`, and `ACC_COMPACT_AT`
overrides the fraction of the window at which the agent compacts itself. The
last one is accepted only when it parses to a number in `(0, 1]`; anything else
is ignored and 0.8 is used.

## Permissions

One gate, `permitted()` in `src/core/tools/registry.ts`. The rule is
**recoverable vs not**, not "bash vs file tools":

- reads and writes inside the project run silently;
- protected paths (`protected.ts`), deletes, and unclassified commands ask, and
  can be remembered for the session;
- anything outside the project, or an escape (`sudo`, `git push`, `dd of=`),
  asks every time and can never be remembered.

A `bash` string is split into stages, tokenized, and stripped of wrappers, so
`ls && rm -rf ~` is judged by its worst stage. `git diff|log|show` is rewritten
with `--no-ext-diff` before it runs.

Hand-written rules in `~/.acc/settings.json` and `<workspace>/.acc/settings.json`
are consulted before the classifier, so a command you have approved by hand stops
asking on every restart: `{"permissions": {"allow": ["bash(npm run *)"]}}`, plus
`ask` and `deny` lists. `*` is the only metacharacter. Precedence is `deny` rule >
escape > `ask` rule > `allow` rule > classifier, so no allow rule can silence
`sudo`, `git push`, `dd of=`, `mkfs*`, a fork bomb, or anything reaching outside
the project. Rules load once at boot; a typo anywhere in the file stops `acc` at
startup with the file named. See `permissions.md`.

## Sessions and reliability

- Every run is stored under `~/.acc/projects/<name>-<hash>/sessions/<id>/` as one
  append-only `session.jsonl`, one `{kind, …}` record per line: what the model
  sees and what the terminal drew, interleaved. A reader ignores a kind it does
  not know. Files are `0600`.
- `/resume` opens a picker listing past conversations by their first task and
  relative age, then reopens the session **in place** and replays the stored
  view, diffs included.
- `/rewind` opens the same picker with one row per user message, newest selected,
  and takes the conversation, the context reading and the files back to that
  point. On disk it appends a marker, so the dropped turns stay in the file and
  only the readers cut. It restores what the agent wrote with `edit_file` and
  `write_file`; anything else is git's, or it asked first. When files are
  involved it names them and asks first, says every time that shell-command
  changes are not restored, and counts what it did in the notice. It ends by
  telling the model the workspace may no longer match the turns that survived,
  so a file gets read instead of assumed; that note lives in the run only and
  is not written to the session. It does not forget approvals you already gave. It reaches past a compaction: the messages a
  summary replaced are still offered, marked `— before the summary`, and picking
  one brings that conversation back.
- A session written before v4 is skipped, never migrated: neither picker sees it.
- Approvals are never stored — they die with the run.
- Old sessions are evicted: 30 days, keeping the most recent 50.
- The 20-turn limit is a checkpoint, not a wall: the agent asks to keep going.
- A turn that dies **before any output** is retried (3 attempts, 1s/2s/4s, only
  connection errors, 429, 5xx). After output it reports the error instead, so
  no half-answer is printed twice.
- A failed session write warns once and the run continues.

## Terminal UI

Ink TUI, adapted from the Python agent's interface: streaming markdown,
diffs in history, spinner and status line, an input box with a slash-command
menu, ↑/↓ prompt history saved to disk, the y/a/n confirm prompt, an exit
summary, and `/clear`, `/context`, `/compact`, `/resume`, `/rewind` plus
`exit`/`quit`/`q`.

`/context` breaks the window down: system prompt, tool definitions,
conversation and free space under the bar. The total is the last turn's measured
usage and survives a `/resume`; the parts are estimated from character count
(`src/core/tokens.ts`) and are marked with a `~`. The parts always add up to the
total exactly.

The estimator is `chars / 4` and runs **low** — measured against a real turn on
2026-08-13 it read 882 where the API charged 1,222, about 28% under. Most of the
gap is the tool definitions: they are JSON schema, and punctuation tokenizes far
closer to one token per character than to four. This is why the readout prefers
the measured total wherever it has one, and why anything that acts on the
estimate needs a margin above it rather than trusting it.

`/compact` replaces the whole conversation with one summary the model writes,
and prints one notice: how many messages went and roughly how much was freed.
The spinner reads `Compacting…` while the summary is in flight. A summary that
fails, or that comes back too short or carrying tool-call markup, is retried
once and then changes nothing.

The agent watches its own context and says when it passes 80% of the window. It
prints `compaction threshold reached` once per run and keeps going; shrinking the
conversation is yours to do with `/compact`. It used to summarize itself at that
point, and that was removed on 2026-08-14: auto and manual compaction shared one
function, and the automatic path re-triggered itself because it carried the task
across the summary and the model redid the work. Compaction is being redesigned;
until then the trigger only reports.

Since 2026-08-14 the trigger reads a **projection**, not the last measurement:
the measured total plus the estimate of whatever was pushed since it was taken.
That is what makes a turn which reads four files visible on the same turn instead
of the next one. `/context` still prints the **measured** total, on purpose — the
trigger has to act, so it needs the current number, while the readout is for you
and is better served by what the provider actually charged. So `/context` can
read a little lower than whatever made the trigger fire, and that gap is the
tool results of the turn you just watched. Only the *difference* of two estimates
enters the projection, so the estimator's 28% shortfall applies to the messages
added since the measurement, never to the whole conversation.

Below the trigger sits a floor: if the next request plus a 32,000-token reply
would not fit in the window, the run stops with `the context is full and cannot
be reduced further; start a new session` rather than sending a request the
provider will refuse. At that point summarizing cannot help either — a compaction
request carries every message plus the instruction, so it is larger than the
request that just failed. With the automatic summary gone, this floor is what
keeps a long unattended run from dying on a provider error.

It announces itself with **one line**, `compaction threshold reached`, and
nothing else: the `Compacting…` spinner underneath already says what is being
done, and the task resuming says it worked. An earlier version printed the
percentage that was hit and a second line counting the messages dropped and
tokens freed; both were cut on 2026-08-13 as noise mid-task. The percentage in
particular was a trap — it reads `165%` whenever a single turn overshoots the
window, which is honest and looks broken. `/compact` keeps its freed-tokens
notice, because there the command *is* the result.

If the summary fails, the run keeps going with one `✖` line and the trigger
stays off for the rest of the run. See `agent-loop.md` for both guards and
`ACC_COMPACT_AT`.

It does **not** print a `/context` readout afterwards, though it did at first.
The notice already carries the number that matters, and the readout straight
after a compaction is the least trustworthy one in the app: there is no measured
total to fall back on until the next real turn, so it shows an estimate that
runs ~28% low. Two numbers, one of them shaky, said less than one. Type
`/context` if you want it. See `sessions.md`.

`src/headless.ts` runs the same loop with no terminal, auto-approving every
prompt. It is for smoke tests only — it cannot prove a prompt did not appear.

## Not built

A byte cap on the copies a write stores, and a git-backed snapshot that would
catch what `bash` changes — both wait for numbers from real use (see
`sessions.md`). Permission modes
(`read_only`, `approve_for_me`), the sandbox, a `/model` picker, network tools, a
debugging transcript, todo panel, skills, memory. Reacting to a provider's context-length rejection by compacting and
retrying — the safety net under the 80% trigger — is also still open: the error
shape differs per provider and none of it can be tested without paying for a
deliberate failure.
