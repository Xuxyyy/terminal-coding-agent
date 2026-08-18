# 01 — Add a read-only `grep` tool and point the model at it

Repo: `coding-cli` (`acc`). Branch: `grep-tool`, off `main`.
Costs money: only the optional step 5, which is behind a checkpoint.

`acc` has no search tool. The system prompt and the `bash` description both tell
the model to search with `grep -rn`, so every search is a shell command: no
`.gitignore` handling, unbounded output, and a permission classification that
has to re-derive "this is a read" from the command text every time.

**This plan is NOT** the permission work. `grep` here ships with no `request`,
exactly like `read_file`, so it never reaches `decide()`. Modes, gating reads,
and widening settings rules are `02-permission-modes.md`.

## Run rules

- **Ask only when the answer changes *what* gets built, not *how*.** Naming,
  test layout, and wording: decide and report. Ask when either answer produces
  work that must be thrown away, when the action costs money, or when a step
  disappears, splits, or changes order.
- **When asking, ask once.** Batch the questions, lead with a recommendation.
- **Never ask about something this plan already answered.** See *Decisions*.
- **Two strikes per step.** If `npm test` fails twice on the same step, stop that
  step, leave it uncommitted, move on. Do not let one step eat the session.
- **Verify with `npm test`.** It runs `tsc` first, so a type error fails the run
  before any test executes. On failure, re-run the one file for full output:
  `node --test dist/tests/core/tools/grep.test.js`.
- **Write the tests inline, not with `test-writer`.** `CLAUDE.md` reserves
  `test-writer` for code that already exists; here the code and its tests are
  written in the same conversation, so a fresh agent would cost more than it
  saves.
- **Never run `acc` inside this repo.** The workspace is the current directory,
  so it would edit itself. Step 5 uses a throwaway folder.
- **Commit each step when green**, on the branch, with the written message.
  Do not push. One subject line, no body, no trailers.
- **Tick the status box** with the short SHA as each step lands.
- **If a step is blocked, skip it and finish the rest.** Scaling the plan down is
  the user's call, not the runner's.
- **Stop at the checkpoint.** Run the `summarize` skill there, then wait for a
  yes before step 5. This plan listing step 5 is not that yes.

## Scope fence — do not touch

- `src/core/permission/**` — all of it belongs to plan 02.
- `src/core/settings.ts` — `RULE_PATTERN` is plan 02 step 3.
- `read_file`'s own behavior. `grep` copies its posture; it does not change it.
- `capLines` in `src/core/tools/read.ts`. `grep` gets its own cap (decision 7).
- `src/ui/**`. `grep` results render through the existing tool-output path.
- No new npm dependency. See decision 2.

## Decisions, already made

1. **Name it `grep`, not `search_files`.** Models carry a strong prior on the
   name from training, which buys correctness on the first call. It also sits
   fine next to `bash`, which is likewise a bare tool name rather than a
   `verb_noun` one.

2. **Shell out to `rg` on `PATH`. No new dependency.** `@vscode/ripgrep` would
   guarantee the binary but adds a postinstall download to a package that has
   none today. `rg` 14.1.1 is present on the dev machine. When `rg` is missing,
   the tool returns a plain error naming the problem and telling the model to
   use `bash` instead — a degraded path, not a crash. Revisit only if the
   missing-binary case actually shows up.

3. **No `request` property.** `permitted()` in `registry.ts` returns before the
   gate when `request` is undefined, which is how `read_file` already skips
   prompting. `grep` is read-only, so it takes the same path. This is deliberate
   consistency, not an oversight — plan 02 gives both tools a gate together, and
   giving `grep` one that `read_file` lacks is the single combination to avoid.

4. **`resolveInWorkspace` on the `path` parameter.** With no `request`, this call
   is the *only* thing keeping `grep` inside the workspace. It also rejects
   symlink escapes, which matters more for a directory walk than for a single
   file read.

5. **Default `output_mode` is `files_with_matches`.** Paths only. This is the
   whole reason the tool is cheaper than `bash`: it makes the common question —
   "where is this?" — answerable in a few tokens, and pushes the model into a
   search-then-read rhythm instead of pulling whole files in to look around.
   `content` and `count` are opt-in.

6. **Respect `.gitignore`; include dotfiles; skip `.git`.** `rg`'s default
   already ignores `node_modules` and `dist` via `.gitignore`, which is the
   single biggest reason a shell `grep -rn` floods the context. Dotfiles are
   included with `--hidden` because `.acc/settings.json` is a real thing to
   search for, and `.git` is excluded explicitly because its object files are
   noise.

7. **`grep` gets its own output cap, head-only, with its own marker.**
   `read.ts`'s `capLines` appends `re-read with offset`, which is advice for a
   file read and wrong here. Cap at 32,000 chars on whole lines and append
   `... [truncated N chars, cap is 32000; narrow with glob or path]`. Head-only
   because search results carry no ordering the tail would preserve, unlike a
   `bash` command whose verdict is at the end.

8. **Three negative results, three distinct messages.** A bare `no matches`
   collapses three different mistakes into one string and the model has to guess
   which repair to attempt. Verified against `rg` 14.1.1:

   | situation | how to detect | message |
   |---|---|---|
   | pattern really absent | `--stats` reports `N files searched`, N > 0 | `no matches — searched N files` |
   | glob/path selected nothing | `--stats` reports `0 files searched` | `no files matched glob '<glob>'` |
   | pattern is invalid | exit code 2, stderr has the diagnostic | `invalid pattern: <rg's own text>` |

9. **Check the path exists before running `rg`.** A missing path makes `rg` exit
   **0** and write an IO error to stderr. Exit 0 reads as success, so without an
   explicit check a typo'd path returns "no matches" and the model concludes the
   code is not there. `read_file` gets this for free from `fs.statSync`; `grep`
   has to do it deliberately.

10. **Both steering strings change, in one step.** `src/core/prompt.ts` and
    `src/core/tools/bash.ts` each tell the model to search with `grep -rn`.
    Changing one and not the other leaves two instructions in contradiction, and
    the one naming a concrete command wins. They are one commit.

11. **`grep` results are clearable during compaction.** Search output goes stale
    as soon as a file changes, and it is recoverable by searching again — the
    same argument `clear.ts` already applies to `read_file`. Without this, a
    long session's grep output is the one tool result compaction cannot free.

## Step 1 — Add the `grep` tool

**Problem:** there is no search tool. `src/core/tools/index.ts` exports four
tools: `readFile`, `editFile`, `writeFile`, `bash`.

**Change:**
- New `src/core/tools/grep.ts`, following the shape of `src/core/tools/read.ts`:
  a zod `schema` with `.describe()` on every field, a `Tool` export, no
  `request`, and `resolveInWorkspace(ctx.root, ...)` before touching disk.
- Parameters: `pattern` (required), `path` (optional, defaults to the workspace
  root), `glob` (optional), `output_mode` (`files_with_matches` | `content` |
  `count`, defaulting to `files_with_matches`), `case_insensitive` (optional
  boolean), `context` (optional number, `content` mode only).
- Spawn `rg` with `--stats --hidden --glob '!.git'` plus the mode flags: `-l`,
  or `-n` with optional `-C`, or `-c`. Parse the `files searched` line out of
  `--stats` and strip the stats block from what the model sees.
- Exit codes: 0 = matches, 1 = no matches, 2 = bad pattern. Map to the three
  messages in decision 8. `ENOENT` on spawn = the `rg`-missing error from
  decision 2.
- Register it in `src/core/tools/index.ts`.

**Tests** — new `src/tests/core/tools/grep.test.ts`, inline, copying the style
of `src/tests/core/tools/tools.test.ts` (its `workspace()` tmpdir helper and its
`context(root, host)` builder):
- a match returns the file path, and nothing else, in the default mode
- `output_mode: 'content'` returns line numbers; `count` returns a total
- a pattern that is absent returns `no matches — searched N files`
- a glob matching no file returns the `no files matched glob` message
- an invalid pattern returns `invalid pattern:` and does not throw
- a path outside the workspace throws from `resolveInWorkspace`
- a path that does not exist returns a clear error, not `no matches`
- a `.gitignore`d file is skipped; a dotfile is found
- output past the cap ends with the truncation marker
- calling it through `runTool` never calls `host.confirm`

That last case is the one that pins decision 3 — assert on the `asked` array
from `hostThatAnswers`, since a count of zero prompts is the whole claim.

**Accept:** `npm test` green.
**Commit:** `feat(tools): add a ripgrep-backed grep tool`
**Status:** - [ ]

## Step 2 — Point the model at `grep` instead of `bash`

**Problem:** two strings actively teach the opposite of what step 1 built.
`src/core/prompt.ts` has `- Use bash to search (grep -rn), to run tests, and to
inspect git.` in `INSTRUCTIONS`, and `src/core/tools/bash.ts` describes `bash`
as `Run a shell command in the workspace root. Use it to search (grep -rn), run
tests, use git, and delete files.`

**Change:**
- In `prompt.ts`, split the line: `bash` keeps tests and git, and searching moves
  to `grep`.
- In `bash.ts`, drop `search (grep -rn)` from the description and name the
  boundary instead — use `grep` to search file contents; reach for a shell
  search only for a pipeline, git history, or another command's output.
- Name the three Bash-only cases explicitly. "Decide based on your task" is too
  vague to change behavior; the cases are what make the choice predictable
  before the call rather than after a failure.

**Tests** — add to `src/tests/core/tools/grep.test.ts`:
- neither `systemPrompt(root)` nor `bash.description` contains `grep -rn`
- `bash.description` mentions `grep`

A string assertion looks brittle, but it is the only thing standing between a
future edit and silently re-teaching the old habit.

**Accept:** `npm test` green.
**Commit:** `feat(prompt): steer search to the grep tool`
**Status:** - [ ]

## Step 3 — Let compaction clear `grep` results

**Problem:** `clearResult` in `src/core/clear.ts` handles `read_file` and `bash`
by name and returns `null` for anything else, so `grep` output would survive
every compaction pass.

**Change:**
- Add a `CLEARED_SEARCH` constant next to `CLEARED_READ` and `CLEARED_OUTPUT`,
  worded so the model knows the result is recoverable — the search can be run
  again.
- Handle `grep` in `clearResult`, keeping the existing `shrinks()` guard so a
  short result is left alone.

**Tests** — add to `src/tests/core/clear.test.ts`, matching how the existing
cases assert on `read_file` and `bash`:
- a large `grep` result is replaced with `CLEARED_SEARCH`
- a result shorter than the marker is left untouched

**Accept:** `npm test` green.
**Commit:** `feat(core): clear grep results when compacting`
**Status:** - [ ]

## Step 4 — Update the docs

**Problem:** `docs/features.md` says "Four tools" and carries a test count.
`docs/agent-loop.md` has a table of what compaction does per tool result, and
`grep` is now a row in it.

**Change:**
- `docs/features.md`: five tools; describe `grep`'s default mode and its cap
  alongside the existing `bash` and `read_file` cap notes; update the test count
  from the actual `npm test` output rather than guessing.
- `docs/agent-loop.md`: add the `grep` row to the clearing table.
- Rewrite the parts that changed. Do not leave the old sentence with a note next
  to it — per `CLAUDE.md`, a layered doc becomes a changelog and the reader
  cannot tell which layer is live.

**Accept:** `npm test` green (docs do not affect it; this confirms nothing broke).
**Commit:** `docs: record the grep tool`
**Status:** - [ ]

## Checkpoint — stop here

Steps 1-4 are green and committed. Now:

1. Run the `summarize` skill — the steps built, each with the `file:line` it
   turned on.
2. Stop and wait for a yes.

Step 5 is a live run against a real model and spends real API credit. Expect a
few cents on the cheap default; the point is a handful of turns, not a long
session. The user's standing rule is that no paid run starts without an explicit
yes, and this plan is not that yes.

## Step 5 — Live run (paid, only after a yes)

**Problem:** every check so far is a unit test. Nothing has confirmed the thing
step 2 is actually for: that a real model reaches for `grep` instead of
`bash`.

**Change:** none. This is verification.

**How:** hand it to the `acc-e2e` agent, on the cheap default model, in a
throwaway folder — never this repo. Seed the folder with a few files, one of
them `.gitignore`d. Ask a question whose natural answer is a search, such as
finding where a function is defined.

**Accept:** the session records show a `grep` call, not a `bash` call carrying
`grep -rn`, and the `.gitignore`d file is absent from the result. Read this off
`~/.acc/projects/<name>-<hash>/sessions/<id>/session.jsonl`, not off the screen.

**Commit:** none — nothing changes unless it fails.
**Status:** - [ ]

## Done means

`acc` has five tools; `grep` returns paths by default, never prompts, stays in
the workspace, and distinguishes its three failure modes. Both steering strings
name `grep`. Compaction can free search output. The docs describe all of it.

Report at the end: what shipped, what was skipped and why, what was decided
without asking, and anything that should change plan 02.

**What plan 02 may now assume:** `grep` exists with no `request`, so both
read-only tools bypass `decide()` the same way, and plan 02 step 2 has two
call sites to convert rather than one. If step 1 shipped a `request` after all —
it should not have — plan 02 step 2 shrinks accordingly and must be re-read
before it is run.

## Setup before the run

```
git switch -c grep-tool
```

The branch matters: `CLAUDE.md` allows committing a finished step without asking
on a branch, but requires approval for every commit on `main`. Starting on
`main` turns a four-commit plan into four interruptions.

`plans/` is untracked, so this file is not part of any commit. Delete it once the
plan ships and fold what lasts into `docs/`.
