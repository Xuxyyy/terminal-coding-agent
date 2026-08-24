# Tools

Status: built.
Covers: `src/core/tools/` — the five tools the model can call, their arguments,
their caps, and the exact text they fail with
Read when: adding a tool, changing a schema, or changing what a tool returns
See also: `permissions.md` (the gate a tool passes on its way to the disk),
`agent-loop.md` (where `runTool` is called from), `features.md` (what ships today)

## The five tools

In the order `src/core/tools/index.ts` registers them, which is the order the
model sees them in.

| Tool | Arguments | What it does | When it asks |
|---|---|---|---|
| `read_file` | `path`, `offset?`, `limit?` | Reads a text file as numbered lines, so `edit_file` can quote it byte for byte. 400 lines by default. | only for a path outside the project, which can never be remembered |
| `grep` | `pattern`, `path?`, `glob?`, `output_mode?`, `case_insensitive?`, `context?` | Searches file contents with `rg`. Returns matching paths only, unless asked for `content` or `count`. | only for a path outside the project, which can never be remembered |
| `edit_file` | `path`, `old_string`, `new_string` | Replaces one exact, unique piece of text. Returns a diff. | for a protected path, and for one outside the project, which can never be remembered |
| `write_file` | `path`, `content` | Creates a file or replaces all of it. Returns a diff. | for a protected path, and for one outside the project, which can never be remembered |
| `bash` | `command`, `description?` | Runs a shell command in the workspace root — tests, git, deleting files. | unless the command reads, or only changes what git can undo |

That column is the `auto-edits` mode, which is the one a session starts in: an
ordinary write inside the project runs silently, because it classifies as
`recoverable` and git can undo it. `ask-edits` asks about it instead. No mode
refuses a tool call on its own — only a rule, an escape, or a path outside the
project does. `permissions.md` has the rule.

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
`src/core/tools/index.ts` is the single source of what is offered. Both modes get
all five today; the parameter is the seam a mode with its own list would use. It
is the default argument of both `runAgent` and `contextStatus`, so what the model
is offered and what the context readout counts can never drift apart.

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
immediately when `tool.request` is absent. Every tool here carries one, so that
early exit never fires today — give a new tool a `request` and keep it that way.
`read_file` and `grep` still never prompt, but now because `decide()` says so: a
read inside the project is `observe`, a read outside it is denied. `grep` passes
`path ?? '.'`, which is what it actually searches. The rule for what a `request`
should be is `permissions.md`'s.

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
Runs `bash -lc` in the workspace root.

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
5. Register it in `src/core/tools/index.ts`. The array order is the order the
   model sees.
6. Decide how `src/ui/events.ts` draws its row — see `features.md`.
