# What `acc` can do today

Status: v5, 2026-08-26. A list of shipped features, not a design doc.
Read when: you want to know what exists before planning what is next.
See also: `agent-loop.md`, `tools.md`, `permissions.md`, `sessions.md`, `mcp.md`,
`headless.md` for *why* each part looks the way it does.

## Shape

One TypeScript package, 6,711 lines outside the tests. `src/core` runs the
agent and never imports React; `src/ui` draws it with Ink. The two meet at one
seam, the `Host` interface (`confirm`, `onEvent`, `signal`). 724 tests, all
passing.

The workspace is the current directory. Installed as the `acc` command.

## The agent loop

- Streaming turn loop: messages → model → tool calls → run → append → repeat.
- Five built-in tools: `read_file`, `grep`, `edit_file` (unique-match),
  `write_file`, `bash`. MCP servers add more — see below.
- `grep` shells out to `rg` on `PATH`. It returns matching paths only unless
  asked for `content` or `count`, it respects `.gitignore`, includes dotfiles,
  and never searches `.git`. When `rg` is not installed it says so and points at
  `bash`; it does not crash.
- Every tool caps its own output, so no single call can outrun the compaction
  trigger, and every truncation marker names the repair to try. `bash` keeps a
  head and a tail; the other tools keep a head only. Sizes and the reasoning are
  in `tools.md`.
- `edit_file` and `write_file` return a diff, drawn in the scrollback.
- Every path is confined to the workspace root before a tool runs.
- Broken tool-call JSON comes back as a tool error, not a crash.
- Esc stops the turn from anywhere inside it — while the model streams, while a
  command runs, while the approval box is open, while the judge is thinking, and
  while an MCP server is slow.
- System prompt carries an environment block: cwd, OS, git, file tree.

## MCP servers

- `acc` is an MCP **client**. Servers are declared in an `mcpServers` block in
  `~/.acc/settings.json` — user settings only, so a repository you cloned cannot
  spawn a process on your machine.
- stdio transport only: each server is a `command` with `args` and `env`, spawned
  at startup. `${VAR}` expands in `args` and `env`; an unset variable stops
  startup and names the variable.
- `"enabled": false` on a server block means it is **never spawned** — no process,
  no startup wait, no tools in the prompt. It still shows in `/mcp` as `disabled`.
- `"tools": ["list_*", "get_file"]` is an **allowlist**: only the tools it matches
  are published, and everything else the server listed is dropped. Patterns are the
  same `*` glob the permission rules use and match the remote name, without the
  `mcp__<server>__` prefix. No key means publish everything; `${VAR}` is not
  expanded here. A pattern matching nothing is reported in `/mcp`, not a startup
  error. This is a context-budget control, **not** a permission — an allowlisted
  tool still asks.
- Their tools are published beside the built-in five as
  `mcp__<server>__<tool>`, and everything downstream — the loop, the gate, the
  UI — treats them as ordinary tools.
- **Every MCP call reaches the permission gate and is never allowed outright.**
  It asks in `ask-edits` and `auto-edits` and goes to the judge in `auto`.
  An approval is remembered per tool for the session, not per server.
- One server failing to start does not stop the CLI or the others: it is recorded
  as failed with a reason, and its tool list is empty.
- `/mcp` shows one line per server: `ready` with a tool count, `6 of 45 tools`
  when filtered, `disabled`, or `failed` with the reason. A pattern that matched
  nothing is named on that server's line.
- `/mcp <server>` prints that server's line and then the tool names it published,
  which is where you read the names to write a `tools` allowlist with. An unknown
  label names the servers that do exist.
- Connection happens at boot, so a settings change needs a restart.

## Models

OpenAI-compatible client, so three providers work through one code path:
DeepSeek, GLM, and Kimi (six model ids). Default is DeepSeek v4 Flash. Keys
load from `.env` files, including `~/.acc/.env`.

The model is chosen in three steps, first hit wins: `ACC_MODEL`, then the
`"model"` key saved in `~/.acc/settings.json` by the `/model` picker, then the
first model in registry order whose provider key is set. An env override a
settings file could beat would not be an override, so `ACC_MODEL` stays on top.

Three environment variables change what the client does: `ACC_MODEL` picks the
model id, `ACC_HOME` moves the session store off `~/.acc`, and `ACC_COMPACT_AT`
overrides the fraction of the window at which the agent compacts itself. The
last one is accepted only when it parses to a number in `(0, 1]`; anything else
is ignored and 0.8 is used.

## Permissions

One gate, `permitted()` in `src/core/tools/registry.ts`. In the mode a session
starts in, `auto-edits`, the rule is **recoverable vs not**, not "bash vs file
tools":

- reads and writes inside the project run silently;
- protected paths (`protected.ts`), deletes, and unclassified commands ask, and
  can be remembered for the session;
- anything reaching outside the project — a file tool or a `bash` command
  alike — asks every time and can never be remembered, and neither an `allow`
  rule nor the `a` key can silence it;
- an escape (`sudo`, `git push`, `dd of=`) asks the same way.

Three **permission modes** move where that line falls, and what happens above it:
`auto-edits` runs reads and project writes silently, `ask-edits` asks before
every write, and `auto` keeps `auto-edits`' line but sends everything above it to
a model instead of to you — one word back, `ALLOW` and it runs silently, anything
else and you get the same confirm box. None of them refuses anything on its own:
above its cut a mode asks or judges, and the judge cannot deny. A session that
cannot write is written as configuration instead: `{"deny": ["edit(**)"]}` in
`~/.acc/settings.json`, which is narrower than a mode could ever be, because it
names paths — and a rule always outranks the judge.

`/permission` switches the mode while you work: a picker of the three names,
each with a sentence saying what it allows, opened on the one you are in. The
conversation survives — only the system message is rewritten, so the prompt and
the tool list follow from the next turn. The header keeps showing the mode you
left, which is a known gap and not a sign the switch failed; the notice under
the picker is what tells you it worked. See *the header does not repaint* below.
The header shows the bare name, `permissions: ask-edits`; the sentences live in
the picker, where
you are choosing. The pick is written back to `"permission_mode"` in
`~/.acc/settings.json`, so the next run starts there too. That key is the only
place the mode is stored, and it is global: the user-level file only, never a
project's, and an unknown name stops `acc` at startup.

The gate governs what the model asks for. `acc`'s own files under `~/.acc` — the
session log, the rewind backups — are written outside it by design.

A `bash` string is split into stages, tokenized, and stripped of wrappers, so
`ls && rm -rf ~` is judged by its worst stage. `git diff|log|show` is rewritten
with `--no-ext-diff` before it runs.

Hand-written rules in `~/.acc/settings.json` and `<workspace>/.acc/settings.json`
are consulted before the classifier, so a command you have approved by hand stops
asking on every restart: `{"permissions": {"allow": ["bash(npm run *)"]}}`, plus
`ask` and `deny` lists. Rules reach files too: `edit(<pattern>)` matches the path
`edit_file` or `write_file` was given, so `{"deny": ["edit(**)"], "allow":
["edit(docs/**)"]}` is a session that may write under `docs/` and nowhere else.
In a `bash` pattern `*` is the only metacharacter and it spans everything; in a
path pattern `*` stops at `/` and `**` crosses it. When several patterns match,
the **most specific** one wins — the one with the most characters that are not `*` —
so `{"ask": ["bash(*)"], "allow": ["bash(git *)"]}` means "ask about everything
except git", and a tie goes to the stricter verdict. A command is judged by its
worst stage. The rule layer then hands its one verdict to `deny` rule > escape >
`ask` rule > `allow` rule > classifier — no mode denies anything on its own — so
no allow rule can silence
`sudo`, `git push`, `dd of=`, `mkfs*`, a fork bomb, or anything reaching outside
the project. A `deny` rule is the way to refuse one outright: it is the only
verdict that reaches a path outside the project, it reaches one only when the
pattern names it absolutely (`edit(~/.ssh/**)`, never `edit(**)`), and it is the
only verdict that governs a read as well as a write. Rules load once at boot; a
typo anywhere in the file stops `acc` at startup with the file named. See
`permissions.md`.

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

## Print mode

`acc -p "<task>"` runs one turn with no terminal and exits — no Ink, no
keyboard, no TTY needed. It is a second implementation of `Host`, in
`src/core/headless/`; the loop, the tools and the permission gate below the seam
are unchanged. The evals reach the same code by importing `runHeadless` instead
of starting the binary.

- stdout is the answer and nothing else, so `acc -p "…" > out.txt` is useful.
  Tool lines, the prompts with their decisions, and the stop reason go to
  stderr. `--json` moves the whole event stream to stdout instead: one object
  per event, then a `{kind: 'result', stopped, usage, prompts, steps}` line.
- Exit 0 when the turn finished, 1 when it stopped early — a denial, a cap, or
  an error. A non-zero exit means the run did not complete, not that the answer
  was bad.
- **Confirms are denied by default.** `--yes` answers `once`, never `session`,
  so nothing is remembered and the gate keeps asking. Every confirm is recorded
  either way, approved or refused — a silent auto-approve would make a prompt
  count a lie.
- Bounded on both axes: the 20-step checkpoint is always denied, so it becomes a
  real ceiling, and `--max-seconds` (default 300) aborts between steps.
- No session is written to `~/.acc`, so running dozens back to back leaves
  nothing behind, and a print run cannot be reopened with `/resume`.
- `--json`, `--yes` and `--max-seconds` throw without `-p`. Interactive mode
  still refuses to start without a TTY. See `headless.md`.

## Terminal UI

Ink TUI, adapted from the Python agent's interface: streaming markdown,
diffs in history, spinner and status line, an input box with a slash-command
menu, ↑/↓ prompt history saved to disk, the y/a/n confirm prompt, an exit
summary, and `/clear`, `/context`, `/compact`, `/resume`, `/rewind`,
`/permission`, `/model` plus `exit`/`quit`/`q`.

A tool row is `• name`, then the argument, then what came back. `bash` splits in
two when the model wrote a `description`: the sentence sits on the row and the
command drops to a child line. `grep` **always** splits that way, with no
headline — the pattern alone would only repeat what the command below already
says.

The command under a `grep` row is `rg` plus the flags the model chose, and
nothing else. Five parts of the real invocation are identical on every search —
`--stats`, `--no-require-git`, `--hidden`, `--glob '!.git'` and `--regexp` — so
they are left out; they carry no information about *this* search. `--regexp`
comes back only when the pattern itself starts with `-`, where dropping it would
make the pattern read as a flag. The trailing `.` stays: without a path argument
ripgrep reads stdin instead of searching, which is the bug that made every early
search hang for the full timeout.

`src/ui/events.ts` imports `chosenArgv` from `src/core/tools/grep.ts` rather than
rebuilding the flag list. Both it and the real `argv` call the same
`chosenFlags`, so a flag can never appear in the command that runs and not in
the command on screen. **Keep it that way** — a hand-copied list in the UI is the
one shape that can silently lie about what was searched. This crosses the seam
in the allowed direction, `src/ui` importing `src/core`, never the reverse.

`/context` breaks the window down: system prompt, tool definitions,
conversation and free space under the bar. The total is the last turn's measured
usage and survives a `/resume`; the parts are estimated from character count
(`src/core/tokens.ts`) and are marked with a `~`. The parts always add up to the
total exactly.

The estimator charges CJK text a token per character and everything else
`chars / 4`, plus a fixed overhead per message and per tool call
(`src/core/tokens.ts`). On English it runs **low** — measured against a real turn
on 2026-08-13 it read 882 where the API charged 1,222, about 28% under. Most of the
gap is the tool definitions: they are JSON schema, and punctuation tokenizes far
closer to one token per character than to four. This is why the readout prefers
the measured total wherever it has one, and why anything that acts on the
estimate needs a margin above it rather than trusting it.

`/compact` replaces the whole conversation with one summary the model writes,
and prints one notice: how many messages went and roughly how much was freed.
The spinner reads `Compacting…` while the summary is in flight. A summary that
fails, or that comes back too short or carrying tool-call markup, is retried
once and then changes nothing.

Past 80% of the window the agent frees context itself, in two steps, cheapest
first.

- **Clearing** runs every turn over the line and costs nothing, because it loses
  nothing. A `read_file` result is a cache, not a record — the file is still on
  disk — so `clearRecoverable` (`src/core/clear.ts`) replaces recoverable tool
  output in place, oldest first: a read or a search becomes a marker naming the
  call to repeat, `bash` keeps its `[exit N]` line and drops the output, and a
  `write_file` call keeps its path and loses its content. It aims at the
  threshold, not at zero, so recent reads survive when they can, and it never
  touches the round in flight.
- **Compacting** runs at the start of a turn, and only when clearing was not
  enough or found nothing left to take. The task message is lifted off the list
  before the summarizer is asked and pushed back after, so the summary is never
  aimed at the work about to start — that was the bug that made the first
  automatic compaction re-trigger itself and the model redo the work. A summary
  that comes back too short or carrying tool-call markup is asked for once more
  with a firmer prompt, then abandoned with the history intact.

`compaction threshold reached` prints once per run, at the point where clearing
finds nothing left to free. Clearing itself is drawn nowhere — it is bookkeeping,
and a line per turn would bury the work.

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
would not fit in the window, the run stops with `the context is full and nothing
more can be freed; send your next message and it will compact first` rather than
sending a request the provider will refuse. Summarizing cannot help inside that
turn — a compaction request carries every message plus the instruction, so it is
larger than the request that just failed — but the next turn starts at step 0,
which is where compaction is allowed to run. The floor is a handoff, not a dead
end.

The threshold announces itself with **one line**, `compaction threshold
reached`, and nothing else: the `Compacting…` spinner underneath already says what is being
done, and the task resuming says it worked. An earlier version printed the
percentage that was hit and a second line counting the messages dropped and
tokens freed; both were cut on 2026-08-13 as noise mid-task. The percentage in
particular was a trap — it reads `165%` whenever a single turn overshoots the
window, which is honest and looks broken. `/compact` keeps its freed-tokens
notice, because there the command *is* the result.

If the summary fails, the run keeps going with one `✖` line and the conversation
is left exactly as it was. See `agent-loop.md` for the three lines and
`ACC_COMPACT_AT`.

It does **not** print a `/context` readout afterwards, though it did at first.
The notice already carries the number that matters, and the readout straight
after a compaction is the least trustworthy one in the app: there is no measured
total to fall back on until the next real turn, so it shows an estimate that
runs ~28% low. Two numbers, one of them shaky, said less than one. Type
`/context` if you want it. See `sessions.md`.

`/model` switches the provider while you work, in the same box, marker and hint
style as `/permission`. All six models are listed in registry order, opened on
the one you are on. A model whose provider key is unset is **shown, not
hidden**: the row stays grey when the cursor lands on it, `enter` refuses it,
and the hint line under the box turns into `set GLM_API_KEY to use this model`.
Hiding the row would leave you wondering where your model went; the grey row
names the variable instead.

A pick swaps the live client, so the next turn — and the permission judge, which
follows the model for free — runs on the new provider. It also moves
`session.contextWindow`, which is what `/context` measures against and what the
80% compaction trigger reads: switching to a 200k model without it would leave
the threshold budgeting for 262k the model does not have.

Unlike `/permission`, a switch does **not** rewrite the transcript. A mode is a
fact about now, so it repaints every past header; a model is a fact about a
point in time, so it gets a divider line at that point and earlier rows keep
naming the model that actually answered them.

The pick is written back to `"model"` in `~/.acc/settings.json`, the same
user-level-file-only rule `"permission_mode"` follows: the key in a project's
`.acc/settings.json` stops `acc` at startup naming the user file, and an unknown
model id stops it listing the six valid ones. `/resume` does not restore the
model a session was last on — reopening a Kimi session while you are running
DeepSeek should not quietly spend money on a provider you did not pick this run.

**The header does not repaint when `/permission` changes the mode.** The picker
closes and the notice prints, but the mode in the header stays stale. It is
ink's `Static` in `src/ui/components/history/HistoryList.tsx:112`, not the
permission code — the same scrollback behaviour `sessions.md` describes, met
from the other side. The line itself is `permissions: {ready.permission.id}` in
`src/ui/components/Welcome.tsx:20`.

**Deliberately not fixed.** Closing it means taking `Welcome` out of `<Static>`
and letting it re-render, and `<Static>` is what keeps the scrollback cheap and
stops earlier rows being redrawn. That trade has not been worth making for one
stale word. Only the *drawing* is stale — `session.mode` is switched correctly,
reopening `/permission` shows the new mode as `(current)`, and a fresh launch
renders it right. This bites every mode, `auto` included: an e2e run of `auto`
saw `permissions: auto-edits` after switching to `auto`, with the settings file
and the picker both already correct.

## Not built

A byte cap on the copies a write stores, and a git-backed snapshot that would
catch what `bash` changes — both wait for numbers from real use (see
`sessions.md`). The sandbox, network tools, a
debugging transcript, todo panel, skills, memory.

On MCP, deliberately: hosted/HTTP transport and the OAuth it needs; resources and
prompts, which are the halves of the spec that are not tools; `mcp(...)` rules in
`settings.json`, so session approval is the only memory an MCP call has — the
`tools` allowlist is a context-budget key and not a substitute for one;
per-project servers, refused on purpose; and reconnect without a restart — a
server that dies mid-session stays dead. `mcp.md` has the reason for each. Reacting to a provider's context-length rejection by compacting and
retrying — the safety net under the 80% trigger — is also still open: the error
shape differs per provider and none of it can be tested without paying for a
deliberate failure.
