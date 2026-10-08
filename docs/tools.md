# Tools

Status: built.
Covers: `src/core/tools/` — the six tools the model can call, their arguments,
their caps, and the exact text they fail with
Read when: adding a tool, changing a schema, or changing what a tool returns
See also: `permissions.md` (the gate a tool passes on its way to the disk),
`agent-loop.md` (where `runTool` is called from), `features.md` (what ships today)

## The six tools

In the order `src/core/tools/index.ts` registers them, which is the order the
model sees them in.

In `auto` mode, only `edit_file`, `write_file`, `bash`, and `agent` are offered.
Reading and searching use Bash. `read_file` and `grep` remain available in
`ask-edits` and `auto-edits`, but are not fallbacks in `auto`.

| Tool | Arguments | What it does | When it asks |
|---|---|---|---|
| `read_file` | `path`, `offset?`, `limit?` | Reads a text file as numbered lines, so `edit_file` can quote it byte for byte. 400 lines by default. | only for a path outside the project, which can never be remembered |
| `grep` | `pattern`, `path?`, `glob?`, `output_mode?`, `case_insensitive?`, `context?` | Searches file contents with `rg`. Returns matching paths only, unless asked for `content` or `count`. | only for a path outside the project, which can never be remembered |
| `edit_file` | `path`, `old_string`, `new_string` | Replaces one exact, unique piece of text. Returns a diff. | for a protected path, and for one outside the project, which can never be remembered |
| `write_file` | `path`, `content` | Creates a file or replaces all of it. Returns a diff. | for a protected path, and for one outside the project, which can never be remembered |
| `bash` | `command`, `description?` | Runs a shell command in the workspace root — tests, git, deleting files. | unless the command reads, or only changes what git can undo |
| `agent` | `description`, `prompt`, `agent?` | Hands one self-contained job to a general or named sub-agent that runs its own turn loop and reports back a single message. | never itself — the child's own tool calls ask, one at a time, as they happen |

That column describes `auto-edits`. The default is `auto`, which allows the same
ordinary project writes but sends above-cut actions to a model judge before
asking a human. `ask-edits` asks about ordinary writes instead. No mode refuses
a tool call on its own; only a deny rule does. The `recoverable` classification
does not guarantee that uncommitted content can be restored. `permissions.md`
has the rule.

**A write's answer depends on the path as well as the mode.** An `edit(...)` rule
in `settings.json` matches the path `edit_file` or `write_file` was given, and its
verdict is taken before the mode's: `{"deny": ["edit(**)"], "allow":
["edit(docs/**)"]}` is a session that may write under `docs/` and nowhere else,
whatever mode it is in. One tag covers both tools, because both reach the gate as
the same `{kind: 'write', path}`.

**A `deny` rule can stop a path outside the project before it is ever asked
about.** The four rows above say what happens with no rule. A `deny` rule whose
pattern names the path absolutely — `deny: ["edit(~/.ssh/**)"]`, never
`edit(**)`, which still means inside the project only — refuses the call with no
prompt at all, and it is the one rule that reaches `read_file` and `grep` as well
as the two writers. Any other rule leaves an outside path where the rows leave
it: asked about, every time, never remembered. `permissions.md` has the matcher
and the chain.

**The list comes from one place.** `toolsFor(mode)` in
`src/core/tools/index.ts` is the single source of what is offered. Every mode
gets all six. In `auto`, it returns copies of the five file and shell tools with
descriptions that prefer Bash for reads and searches, and Edit or Write for
ordinary file changes. Other modes retain the original descriptions.
Schemas, handlers, order, and shared tool objects do not change. It is the default
argument of both `runAgent` and `contextStatus`, so what
the model is offered and what the context readout counts can never drift apart.

The system prompt carries the same preferences. Prefer Bash for reading,
searching, and running commands. Prefer `edit_file` and `write_file` for ordinary
file changes so `/rewind` can use their existing backups when available:
`edit_file` for partial edits, `write_file` for new files or full replacements.
These are preferences, not restrictions; Bash remains available for edits,
tests, formatters, and generators. Read and Grep remain useful for bounded
output, search options, and sensitive-file exclusions. A child follows its
effective permission mode and keeps its configured tool allowlist.

Shell changes are not backed up for `/rewind`. Git cannot reliably recover
overwritten uncommitted work. Existing file-tool backups are why auto prefers
Edit or Write for ordinary changes. Shell searches do not inherit the Grep tool's
sensitive-file exclusions. The auto guidance calls for narrow searches, targeted edits, and
inspection of partial effects before retrying a failed command. Permission,
sandbox, and backup behavior stay the same.

`agent` is the one tool `toolsFor` creates inside the function rather than
keeping in the exported `tools` array, and that is load-bearing. Each call to
`makeSubagent()` reads the definitions loaded during startup, so every new run
gets the current schema and routing descriptions. `index.ts` and `subagent.ts`
also import each other because the child needs the registry; delaying creation
until call time keeps that cycle away from module initialization. Moving one
constructed instance into the array would freeze an empty or stale cache.

## The shape every tool shares

A tool is a `Tool` — `name`, `description`, `schema`, an optional `request`, and
`run` (`src/core/tools/registry.ts`).

Two of those fields are not documentation.

**`description` and every `.describe()` string are the prompt.** `toolDefinitions`
runs the zod schema through `zodToJsonSchema` and hands the result to the API, so
the wording a field carries is the only instruction the model gets about that
field. Editing it is editing the prompt. It also moves a number you can watch:
tool definitions are their own line in `/context`, and because JSON schema is
mostly punctuation it tokenizes far closer to one token per character than to
four — a long `.describe()` costs more than its length suggests.

**A tool with no `request` never reaches the gate.** `permitted()` returns
immediately when `tool.request` is absent. The five file and command tools carry
one. `agent` deliberately does not: starting a child is
not itself an action on the workspace, while every tool the child calls still
has its own permission decision. `read_file` and `grep` do not prompt for an
inside-project read because `decide()` classifies it as `observe`; an outside
read still asks. `grep` passes `path ?? '.'`, which is what it actually searches.
The rule for what a `request` should be is `permissions.md`'s.

### What `runTool` does before `run`

In order, and every failure below comes back as tool-result text starting
`Error:` — the loop never sees a throw:

1. find the tool by name — `unknown tool 'x'` if there is none;
2. `JSON.parse` the raw argument string — a broken stream of tool-call deltas
   ends here, with a message telling the model to resend one JSON object;
3. `safeParse` against the schema — the reply names each bad field as
   `path: message`, so the model can repair one argument instead of guessing;
4. `permitted()`;
5. `ctx.backup(path)` when the request is a `write` — this is the copy `/rewind`
   restores, taken before the write, and its own failure is swallowed on purpose:
   a snapshot that cannot be written must not stop the edit;
6. `run`, with anything it throws turned into `Error: <message>`.

## `read_file`

`path`, and optionally `offset` (1-based, default 1) and `limit` (default 400).

Returns lines as `number\ttext`. **The numbering is what makes `edit_file`
usable** — the model has to quote `old_string` byte for byte, and a numbered
listing is what lets it copy a region exactly and say where it came from.

Four caps, each with a different job:

- **512 KB file size** — refused before reading, so a binary or a bundle cannot
  be pulled into memory at all.
- **400 lines** by default, the window `limit` overrides.
- **500 chars per line**, marked `... [truncated]` — one minified line cannot
  spend the whole budget.
- **32,000 chars of output**, on whole lines, **head only**. A file is read from
  the top and its numbers must stay contiguous; a kept tail would produce a
  listing with an invisible gap in the middle, which reads as a real file. The
  marker names the cap — `... [truncated N chars, cap is 32000; re-read with
  offset]` — so the repair the model reaches for is a second call with an
  `offset`, not the conclusion that the file ended.

Fails on a directory, on a file over the size limit, and returns
`[file has N lines; nothing to show from line X.]` when `offset` is past the end
— a message, not an error, because the model asked a reasonable question about a
file shorter than it thought.

Any partial read appends `[file has N lines; showing X-Y.]`.

## `grep`

`pattern`, and optionally `path`, `glob`, `output_mode`, `case_insensitive`,
`context`. Shells out to `rg` on `PATH`.

**It returns matching paths only unless asked otherwise.** `output_mode` takes
`files_with_matches` (the default, `-l`), `content` (`-n`, plus `-C` when
`context` is set), or `count` (`-c`). Paths-only keeps "where does this live?"
answerable in a few tokens, and it pushes the model into search-then-read rather
than pulling whole files in to look around.

Four flags are always on and are not the model's to choose: `--stats`,
`--no-require-git`, `--hidden`, and `--glob !.git`. So dotfiles are searched,
`.gitignore` is still respected, and `.git` never is. The pattern is always
passed as `--regexp` so a pattern starting with `-` cannot be read as a flag.

`--stats` is parsed off the end of stdout and never shown, except that `count`
mode appends `N matches in M files`. The count is the point of that mode.

**Three empty results are three different sentences**, because one `no matches`
makes the model guess which repair to try:

- `no matches — searched N files` — the pattern is absent;
- `no files matched glob '…'` — the glob selected nothing;
- `no files to search in '…'` — the path holds nothing to search;
- and `invalid pattern: …` on exit 2 — the regex will not parse.

When `rg` is not on `PATH` the tool says so and points at `bash` with
`grep -rn`. It does not crash. A search over 30 s returns
`search timed out after 30s; narrow it with glob or path`.

Output caps at **32,000 chars, head only**, ending `... [truncated N chars, cap
is 32000; narrow with glob or path]`. Search results carry no ordering a tail
would preserve, so the repair is a narrower search, not an offset — which is why
this marker names a different fix than `read_file`'s.

`chosenArgv` is exported for the UI, and it is deliberately **not** the argv that
runs: it drops the four always-on flags and prints the path the model actually
gave. The row shows the search the model chose, not the plumbing around it.

## `edit_file`

`path`, `old_string`, `new_string`. Returns `Edited '<path>'.` and a diff.

**`old_string` must match exactly once.** Zero matches and two matches are
separate errors, and the two-match one names the count and asks for more
surrounding text. Replacing the first of several matches would be a silent wrong
edit; refusing is cheap, because the model still holds the numbered read.

An empty `old_string` is refused with a pointer to `write_file`, since an empty
needle would otherwise match at position 0 and prepend.

The replacement goes through `String.replace` with a **function**, so `$&` and
friends in `new_string` are inserted literally rather than expanded as
replacement patterns.

## `write_file`

`path`, `content`. Creates parent directories, returns
`Wrote N chars to '<path>'.` and a diff.

It replaces the whole file, so its `description` steers the model to `edit_file`
for a partial change — a whole-file rewrite of a file the model only half
remembers is how content disappears.

Both writers return a `DiffPayload`, which is what the scrollback draws. The
`before` side is read from disk first, and is `''` when the file is new.

## `bash`

`command`, and an optional `description` the confirm prompt shows as the reason.
Runs `bash --noprofile --norc -c` in the workspace root. Sandbox defaults to Off;
`/sandbox` or `--sandbox on|off` selects it. Both modes use a private HOME and temporary
directory with a clean environment. With On, network is off by default and `access`
requests one-call grants for outside paths or network. Off ignores `access` and adds
no OS file or network restrictions. Permission checks remain active in both modes.
The file workers and backups use the same selected mode. On is supported only on
macOS; Linux uses Off. See `sandbox.md`.

Output is always `[exit N]` on its own first line, then stdout and stderr
**interleaved into one stream** — the order they actually happened in, which is
what a reader needs when a command fails midway.

Capped at **10,000 chars of head plus 20,000 of tail**, the only tool that keeps
a tail: a command's verdict is usually at the end, and a test run's head is setup
noise.

Three exits are synthesized, not returned by the command:

- **124** — killed by the 120 s timeout, with `command timed out after 120s`
  appended;
- **130** — `ctx.host.signal` aborted, i.e. Esc, reported as
  `stopped by the user`;
- **1** — the process could not spawn at all, carrying the spawn error.

## `agent`

`description`, a few words the terminal row shows, `prompt`, the whole job, and
optional `agent`, the name of a global definition. Returns the child's final
message and nothing else. When definitions exist, their sorted names are an
enum in the schema and each `name: description` line is appended to the tool
description, so the parent model has the routing information.

Definitions are direct regular `<ACC_HOME>/agents/*.md` files loaded once at
startup. They are global because choosing a model or a tool set is user policy,
not something a cloned workspace may impose. Invocation still uses the
parent's current workspace. The Markdown body is appended to the fixed
`subagentPrompt`; it cannot replace the isolation and reporting rules.

It starts a second agent loop with a fresh `Session`. An unnamed call, or a
missing field in a named definition, keeps the existing defaults: the exact
parent `ModelChoice`, all currently available tools except `agent`, and the
parent mode. A configured model client is created only when that type runs. A
configured tool list is exact and keeps its written order after intersection
with the live tool registry. A configured mode resolves to the
stricter of it and the parent mode: `ask-edits` > `auto-edits` > `auto`.

Missing provider keys and configured tools that are unavailable are invocation
errors naming the agent and missing dependency. They do not stop startup.
Invalid files do stop startup, because
silently dropping a type would leave the parent routing against a different
tool schema.

The parent blocks until the child stops, then gets one string back — the
concatenated text of the child's last turn, plus any error it hit. A child that
says nothing comes back as `the sub-agent returned nothing`, because an empty
tool result reads to the model as a bug rather than an answer.

**The point is the context, not the parallelism.** Nothing runs at the same
time. What the child spends — twenty reads to find one line — is spent in its
own window and thrown away, and only the paragraph comes back. That is why the
prompt tells it its final message is the whole report: every file it read and
every command it ran is gone the moment it returns.

Four things it deliberately does not do.

**It does not forward a single event.** `childHost` swallows all of them into a
local array. This is stronger than `withoutText` (`src/core/compact.ts:42`),
which only drops `text_delta`, and it has to be: a forwarded `turn_end` would
tell the terminal the parent's turn had ended, and a forwarded `tool_start`
would break the one-row promise. The parent draws one `agent` row, exactly like
`bash`.

**It does not get the store.** No `SessionStore` is passed, so nothing the child
says is written to the parent's `session.jsonl`. Passing one would append the
child's messages as if the parent had said them, and `/resume` would replay them
into the parent's context — which is the one thing a sub-agent exists to avoid.

**It cannot spawn one of its own.** `childTools` is `toolsFor(mode)` minus
`agent`. Without that filter the recursion has no floor.

**It never asks on its own behalf.** The tool carries no `request`, so it does
not reach the gate. Its child's calls do, one at a time, against the parent's
`allowed` set — a "yes, this session" the user already gave is not asked for
twice — and each reason arrives prefixed `sub-agent: `, so a prompt appearing
mid-run is not mistaken for the parent's own.

Its tokens count toward the turn total and the session total, through
`ToolOutput.usage` and `recordToolUsage`. They are kept out of the context
measurement on purpose; `agent-loop.md` has why.

`childTools(mode, allow?)` and `subagentPrompt(root, mode, role?)` are the two
runtime seams named definitions use. A definition may **narrow, never widen**:
the allowlist is checked against `toolsFor(mode)`, so it cannot invent a tool,
and what survives still passes `permitted()`. `stricterMode` prevents a type
from upgrading its parent's permission mode. `agent` is removed even if an
in-memory caller bypasses file validation, so recursion has two defenses.

## Paths

`resolveTarget` runs before every file tool (`src/core/tools/paths.ts`). It
expands `~`, resolves the argument against the root, and returns it. It judges
nothing — the gate is `permitted()`, and a second one here would make the
prompt a door that does not open.

A symlink inside the workspace pointing out of it needs no check of its own:
`insideRoot` (`permission/protected.ts:50`) calls `realPath()` on both sides, so
the link already resolves outside and classifies as `escape`. The gate catches
it earlier, and answers with a prompt instead of a throw.

`displayPath` is the name shown to the user and written to a checkpoint. Inside
the root it is the relative path; outside it, the absolute one — `../../../..`
is not a path anyone can read.

`bash` is not covered by any of this. It runs with `cwd` set to the root and
nothing more; what stops it is the permission gate, not a path check.

## Adding a tool

1. Write the zod schema with a `.describe()` on **every** field, and remember it
   is prompt text.
2. Add a `request` only if the tool does something git cannot undo. No `request`
   means no prompt, ever.
3. Cap the output inside `run`. Every tool caps its own, so that no single call
   can outrun the compaction trigger, and say in the marker what repair to try.
4. Fail with a sentence that names the fix, not just the problem. Every error in
   this file is written for a reader that has one chance to repair the call.
5. Register it in `src/core/tools/index.ts`, in the `tools` array — unless it
   imports the registry back, as `agent` does, in which case it goes into
   `toolsFor` for the reason above. The array order is the order the model sees,
   and this step is what makes the tool available.
6. Decide how `src/ui/events.ts` draws its row — see `features.md`.
