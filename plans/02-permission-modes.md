# 02 — Permission modes, and one gate for reads

Repo: `coding-cli` (`acc`). Branch: `permission-modes`, off `main`.
Costs money: no. Every step here is verified by `npm test`.

**Assumes `01-grep-tool.md` has shipped.** Steps 2 and 3 convert two read-only
tools, `read_file` and `grep`. If plan 01 has not run, step 1 still stands on its
own — it touches neither tool — but stop before step 2 and say so.

**Written at the level of decisions, not code.** No line numbers and no exact
signatures, deliberately: plan 01 changes the tool layer underneath this one, and
those are the details that would go stale. Read the current code before each
step; the decisions below are what survives.

## What is true today

`acc` has a finished **classification** and no **modes**.

Classification is real and ranked — `observe` < `recoverable` < `protected` <
`destroy` < `escape`, with worst-stage-wins across a compound command. That is
the hard part and it is done.

Modes do not exist. The only `mode` anywhere in `src/` is filesystem permission
bits. What stands in for them is a single hardcoded constant in `decide.ts`
listing which levels are auto-allowed — `observe` and `recoverable`. That is a
real mode; it simply has no name and cannot be changed.

Two further facts, both verified, that shape step 2 and step 3:

- **`read_file` never reaches the gate.** `permitted()` returns early when a tool
  has no `request`. Its only workspace boundary is `resolveInWorkspace` throwing
  from inside `run`. So `bash("cat ~/.ssh/id_rsa")` is classified `escape` and
  prompts, while `read_file("~/.ssh/id_rsa")` is stopped by a different
  mechanism, with different wording, and with no rules involvement.
- **Settings rules can only name `bash`.** The rule pattern in `settings.ts`
  matches `bash(...)` and nothing else, so a rule about `read_file` would be
  rejected by the parser. Reads are therefore unreachable by rules for *two*
  independent reasons, and fixing one without the other buys nothing.

## Run rules

- **Ask only when the answer changes *what* gets built, not *how*.**
- **When asking, ask once.** Batch, and lead with a recommendation.
- **Never ask about something this plan already answered.** See *Decisions*.
- **Two strikes per step.** If `npm test` fails twice on one step, leave it
  uncommitted and move on.
- **Verify with `npm test`.** It runs `tsc` first. On failure, re-run the single
  file: `node --test dist/tests/core/permission/<file>.test.js`.
- **Write the tests inline.** Same reason as plan 01: the code and its tests are
  written in one conversation, so `test-writer` would cost more than it saves.
- **Read `docs/permissions.md` before touching `src/core/permission/`.** The
  project requires it, and this plan changes what that doc describes.
- **Commit each step when green**, on the branch, with the written message. Do
  not push. One subject line, no body, no trailers.
- **If a step is blocked, skip it and finish the rest.**
- **Stop at the checkpoint** and run `summarize`.

## Scope fence — do not touch

- **No runtime mode switching.** No key binding, no `/mode` command, no UI
  affordance. Mode is fixed when the session starts. Reason in decision 4.
- **No new levels.** Five is enough; this plan changes where the cut falls, not
  what is being cut.
- The classifier's own judgments. If `observe` is wrong about some command, that
  is a separate bug and a separate commit.
- `src/ui/**`, except whatever minimal display the mode needs.

## Decisions, already made

1. **A mode is a threshold on the existing rank, not a new concept.** The levels
   are already ordered, and the current behavior is already one cut point on that
   order. Making the cut a parameter turns three modes into a config change
   rather than three code paths, and it means a mode cannot disagree with the
   classifier — it can only be stricter or looser about the same judgment.

2. **Three modes, and no more.**

   | mode | auto-allows up to | for |
   |---|---|---|
   | `read-only` | `observe` | explore and explain, touch nothing |
   | `default` | `recoverable` | today's behavior, unchanged |
   | `yolo` | `destroy` | a throwaway sandbox |

   Note what is *not* here: Claude Code's `acceptEdits` has no analogue, because
   `acc`'s default already auto-allows recoverable writes. What `acc` is missing
   is a **stricter** mode, not a looser one. `default` must stay byte-for-byte
   the current behavior so this step is invisible to anyone who does not opt in.

3. **`escape` is never auto-allowed, in any mode, including `yolo`.** That is
   what makes it a guardrail rather than a level, and it matches the existing
   rule that an `escape` outcome is never remembered for the session. A mode that
   could switch off `sudo` and `git push` prompts would make the level meaningless.

4. **Mode is set once at startup, by a CLI flag.** Not a settings key, not a
   runtime toggle. A settings key invites a project to make itself permanently
   `yolo`, which is exactly the file an untrusted repo would ship. A runtime
   toggle is real UI work in `src/ui`, and it belongs to a later slice once the
   threshold plumbing has proven itself. A flag is the smallest surface that
   makes the feature usable and is cheap to widen later.

5. **Reads get their own request kind, rather than a flag on `Tool`.** An earlier
   sketch added an explicit read-only marker to the tool type. The threshold
   design makes that unnecessary and worse: with a request kind, a read-only tool
   is simply one that can never classify above `observe`, so `read-only mode` and
   `read-only tool` become the same word checked in one place. A separate boolean
   would be a second vocabulary for the same idea, free to drift out of sync.

6. **The classifier work for step 2 already exists.** The function that judges a
   read target — the one used for the arguments of a read-only shell stage,
   called with the reading flag — already produces the right level and the right
   wording for a path outside the project. Step 2 is wiring, not new judgment.
   Reuse it; do not write a second one.

7. **`read_file` and `grep` convert in the same commit.** Giving one a gate the
   other lacks is the inconsistency that later reads as a bug, and it is the one
   combination worth avoiding. They are one step.

8. **Step 2 without step 3 is incomplete but not wrong.** After step 2, reads are
   classified and obey the mode; they are still not addressable by a settings
   rule, because the rule parser only accepts `bash(...)`. Ship step 2 anyway —
   it is what makes `read-only` mode actually cover reads — and land step 3
   after. Do not merge them to avoid the intermediate state.

## Step 1 — Make the allowed levels a mode threshold

**Problem:** the set of auto-allowed levels is a hardcoded constant in
`decide.ts`. There is one mode and it cannot be named or changed.

**Change:** replace the constant with a threshold carried through to `decide()`,
expressed against the existing rank. Add the three modes from decision 2 and the
`escape` floor from decision 3. Add a CLI flag to select one, defaulting to
`default`. Thread it to wherever the tool context is built, alongside the rules
that already travel there.

**Tests:** in `src/tests/core/permission/`, matching the existing style there —
- `default` reproduces today's outcomes exactly, level by level
- `read-only` asks for a recoverable write that `default` allows
- `read-only` still allows an `observe` command with no prompt
- `yolo` allows `protected` and `destroy`
- `yolo` still asks for `escape`, and that outcome is still not suppressible
- an unknown mode name is rejected at startup rather than silently defaulting

The first and last cases matter most: one proves the change is invisible by
default, the other stops a typo becoming a permissive session.

**Accept:** `npm test` green.
**Commit:** `feat(permission): add read-only and yolo modes`
**Status:** - [ ]

## Step 2 — Route file reads through the gate

**Problem:** `read_file` and `grep` skip `permitted()` entirely, so neither obeys
the mode from step 1, and the workspace boundary for reads is enforced in a
different place, with different wording, than for every other action.

**Change:** add a read kind to the request type. Give both read tools a
`request`. In `decide()`, classify it with the existing read-target function
(decision 6): inside the project is `observe`, outside is `escape`. Keep
`resolveInWorkspace` where it is — defence in depth, and it catches symlink
escapes the classifier does not model.

**Tests:**
- a read inside the project is `observe` and prompts in no mode
- a read outside the project is `escape` and prompts in every mode, including
  `yolo`, and is not suppressible
- `grep` and `read_file` produce the same outcome for the same path
- `resolveInWorkspace` still throws for a path that gets past the gate

**Accept:** `npm test` green.
**Commit:** `feat(permission): gate file reads through decide`
**Status:** - [ ]

## Step 3 — Let settings rules name tools other than `bash`

**Problem:** the rule pattern in `settings.ts` accepts only `bash(...)`, so the
rules a user can write cover one tool. After step 2 reads are classified, but a
user still cannot write a rule about them.

**Change:** widen the pattern to accept a tool name before the parentheses, and
match a rule against the request's tool. Keep `bash(...)` working exactly as it
does — existing settings files must not break. Decide and record what an unknown
tool name in a rule does; rejecting it at load time is consistent with the
project's existing refusal to start on a broken settings file.

**Tests:**
- every existing rules test still passes untouched
- a `read_file(...)` deny rule blocks a read
- a rule naming an unknown tool is rejected at load, with the file named
- a `bash(...)` rule does not match a `read_file` request, and the reverse

**Accept:** `npm test` green.
**Commit:** `feat(settings): let rules name tools other than bash`
**Status:** - [ ]

## Step 4 — Rewrite `docs/permissions.md`

**Problem:** the doc describes one hardcoded cut point, a gate that only `bash`
reaches, and rules that only name `bash`. After steps 1-3 all three are wrong.

**Change:** rewrite the affected sections. `docs/features.md` also summarizes the
permission rule and needs the same treatment. Per `CLAUDE.md`, rewrite the part
that changed rather than leaving the old version with a note beside it — keep a
reason only where it still decides something, such as why `escape` sits outside
the threshold.

**Accept:** `npm test` green.
**Commit:** `docs: describe permission modes`
**Status:** - [ ]

## Checkpoint — stop here

Run the `summarize` skill, then stop. There is no paid step in this plan, but the
summary is still the last thing written.

## Done means

A mode selects how much `acc` does without asking, expressed as one cut point on
a rank that already existed. Reads are classified like everything else, so
`read-only` mode genuinely covers them. Rules can name any tool. `default`
behaves exactly as it did before this plan.

Report at the end: what shipped, what was skipped and why, what was decided
without asking, and whether decision 4 — flag only, no runtime toggle — still
looks right after using it.

## Setup before the run

```
git switch -c permission-modes
```

`plans/` is untracked, so this file is in no commit. Delete it once it ships and
fold what lasts into `docs/permissions.md`.
