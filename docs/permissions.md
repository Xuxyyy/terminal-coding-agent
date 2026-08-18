# Permissions

Status: built.
Covers: `src/core/permission/`, `permitted()` in `src/core/tools/registry.ts`, `Confirm.tsx`
Read when: changing what the agent asks about, or adding a tool that touches the disk
See also: `agent-loop.md` (where the gate is called from)

**Goal:** the agent runs a real task start to finish without a single prompt, and still stops
before anything git cannot undo.

## The rule

The split is not "bash vs file tools". It is **what git can undo** versus what it cannot.

| what the action does | decision | offers `a`? |
|---|---|---|
| reads inside the project | allow | — |
| writes inside the project — `edit_file`, `write_file`, or `echo >` alike | allow | — |
| runs `npm`/`pnpm`/`yarn` with `test` or `run` | allow | — |
| writes to a protected path (`protected.ts`) | ask | yes |
| deletes (`rm`, `rmdir`, `find -delete`) | ask | yes |
| touches anything outside the project, reads included | ask | **no** |
| escapes (`sudo`, `git push`, `dd of=`, `mkfs*`, fork bomb) | ask | **no** |
| cannot be classified | ask | yes |

One sentence you can say out loud: **git can undo a change to a file in the repo; it cannot
undo a delete, a push, or anything outside the repo.**

The same effect gets the same answer through any tool. `write_file src/a.ts` and
`echo x > src/a.ts` are both free. Asking about every `write_file` while letting `ls` through
is not defensible on its own terms, and neither is the reverse.

Failure direction is **fail closed**: anything unparsed asks.

## Levels

```ts
// classify.ts
type Level = 'observe' | 'recoverable' | 'protected' | 'destroy' | 'escape';
type Classification = {level: Level | null; reason: string};
```

`null` is "cannot be classified from its text" — not a sixth level, because it has no rank.
`protected` and `destroy` are levels rather than flags on a classification, because under the
rule above they decide the answer rather than decorating it.

Rank for "worst stage wins": `observe` < `recoverable` < `protected` < `destroy` < `escape`.
An unclassified stage makes the whole command unclassified, **unless** another stage escapes —
an escape anywhere wins outright.

`decide.ts` allows `observe` and `recoverable`; everything else asks. `suppressible` is
`level !== 'escape'`, so an escape can never be remembered, and an unclassified command can.

## Rules file

Hand-written, read at boot, never reloaded. Two files, concatenated in this order:
`~/.acc/settings.json` (`ACC_HOME` moves it), then `<workspace>/.acc/settings.json`.

```json
{
  "permissions": {
    "deny":  ["bash(curl *)"],
    "ask":   ["bash(npm run deploy*)"],
    "allow": ["bash(npm run *)", "bash(python3 scripts/*)"]
  }
}
```

Everything is optional, including `permissions`. `bash(...)` is the only tag; the tag is
required and any other one is a startup error. Keeping it means `write(...)` and `edit(...)`
slot in later without a format migration, and — more to the point — a rule the user believes
is granted can never be silently ignored. Only `bash` rules exist because an edit-specific
permission mode owns `write_file` and `edit_file`; two systems deciding one thing is the bug.

`*` matches any run of characters, spaces included. Nothing else is a metacharacter: `?`,
`[a-z]` and regex are literal. One rule to learn, and `classify.ts` already carries all the
subtlety this subsystem can afford.

A pattern is matched against the **hardened, normalized** command — stages split by
`splitStages`, each rebuilt by `commandParts(...).join(' ')`, the same normalization
`approvalKey` uses. So `npm  run   build` and `npm run build` are one rule, and what a rule
matched is what actually runs. Across stages, `allow` needs **every** stage to match while
`deny` and `ask` fire on **any** — the same "worst stage wins" reasoning as the classifier.
Without it `bash(git status*)` would allow `git status && rm -rf x`. A command that fails to
parse can never be allowed; a `deny` pattern may still match its raw text.

Precedence: **`deny` rule > escape > `ask` rule > `allow` rule > classifier.** The escape sits
above every allow rule on purpose. `escape` is exactly the set of irreversible or
project-escaping actions, and a session approval for one is already never remembered; a file
that could silence it would make that guarantee false. The accepted cost is that there is no
way to stop `acc` asking about `git push`.

A broken file **refuses to start**: bad JSON, a rule that is not a string, an unknown key
inside `permissions`, or any other tag prints the file and the problem and exits 1. This file
grants permissions, so running with a partial set means believing in rules that are not
active — the failure that actually hurts. The user just edited the file, so the error lands
while they are still looking at it. Unknown **top-level** keys are ignored silently instead:
`model`, `permission_mode` and `transcripts` reserve names for later slices, and strictness
belongs where a mistake is dangerous.

`loadSettings()` runs at boot in `cli.tsx` and `headless.ts` and caches the merged rules;
`createSession` reads them from `rulesOf()`. It is module-level, like `loadEnvFiles()`, rather
than a prop threaded through `App → useAgent → createSession` — that would put a core concern
in the UI layer. Editing the file needs a restart, so a session's behaviour stays explainable
afterwards. `/clear` does not touch them: rules are config, not session state.

## Pipeline

For one `bash` command:

0. **Rules file** — the hardened command is matched against `deny`, `ask` and `allow`
   (`rules.ts`). A `deny` verdict ends it here. An `ask` or `allow` verdict is held, not
   applied: the classifier still runs, and an `escape` overrides it. Steps 1-9 below are the
   classifier, reached whenever no rule decided.
1. **Fork bomb** — matched against the whole command before anything is split.
2. **`splitStages(command)`** — split on `&& || |& ; | &` and newlines, aware of quotes,
   backslashes, and heredocs. Unbalanced quotes → unclassified. This is the part that makes
   `ls && rm -rf ~` honest.
3. **`commandParts(stage)`** — a small `shlex.split`, then skip `VAR=x` assignments and `env`,
   `nice`, `nohup`, `stdbuf`, `time`, `timeout`, `xargs`, `command`, `builtin` to find the real
   executable. Node has no `shlex`, so it is written, not imported. Failure → unclassified.
4. **Escaping executable** — `sudo`, `mkfs*`, `dd of=`, `git push` → `escape`.
5. **Write targets** — redirect targets (`>`, `>>`, after discarding `2>/dev/null` and
   friends) plus the non-flag arguments of `cp ln mkdir mv rm rmdir tee touch`. If a stage has
   write targets **and** contains `` ` ``, `$`, `(` or `)`, the target cannot be determined →
   `escape`. Otherwise resolve each against the root: outside → `escape`; the root itself with
   a destructive command → `escape`; protected → `protected`; a delete → `destroy`; else
   `recoverable`.
6. **Read-only stage** — executable in `{cat cd diff echo find grep head ls od pwd rg sort
   tail test wc}`, or `git` with `{diff log ls-files show status}`; no substitution, no
   redirect, no unsafe option (`git --ext-diff`, `git --textconv`, `rg --pre`, `sort -o`,
   `find -exec/-delete`). Then check what it reads: any path outside the root → `escape`, else
   `observe`.
7. **Project runner** — `npm`, `pnpm` or `yarn` with `test` or `run`, and no substitution →
   `recoverable`. These stay inside the project and are the commands a real task runs most.
8. otherwise → unclassified.
9. **Worst stage wins.**

`bash -lc "..."`, `python -c`, `node -e` and similar land in unclassified and therefore ask.
That is the intended answer: we do not try to parse a nested shell, we refuse to guess.

## Hardening

`harden.ts` rewrites `git diff|log|show` to add `--no-ext-diff` unless it is already there.
Without it, a repo's own `.gitconfig` can point `diff` at any program and the agent runs it.

The hardened string is what the user sees in the prompt **and** what actually runs: `decide()`
returns it as `command`, and `runTool` passes that into `bash.run` in place of the model's
original string.

## Types

```ts
// src/core/permission/decide.ts
function decide(request: Request, root: string, rules?: Rules): Outcome;

type Request =
  | {kind: 'command'; command: string; reason?: string}
  | {kind: 'write'; path: string};

type Outcome = {
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
  command?: string;      // hardened, for kind: 'command'
  suppressible: boolean;
};

// src/core/settings.ts — the patterns, tag already stripped
type Rules = {allow: string[]; ask: string[]; deny: string[]};
```

`rules` defaults to empty, which is what keeps every caller that has no rules to give — and
every test written before the file existed — compiling and behaving as it did. For
`kind: 'write'` it is ignored entirely.

`'deny'` is returned only by a `deny` rule. It is never suppressible: a denial the user can
click past is not a denial. This is also the path a `read_only` mode is made of, so that mode
becomes a rule generator rather than new plumbing.

## Enforcement

`permitted()` in `registry.ts` calls `decide()` and builds the `ConfirmRequest` from the
`Outcome`. It is the only place permission is checked.

One rule there, which the type alone does not carry: **only store a session approval when
`outcome.suppressible` is true.** A `'session'` answer to a non-suppressible prompt is treated
as `'once'`. That is what stops a guardrail from ever being remembered.

Session memory is keyed on the **normalized whole command**, stage by stage, joined with `; `
(`approvalKey`). Keying on the first word — which an earlier version did — meant that pressing
`a` on `git status` also approved `git push --force` for the rest of the session.

`allowed` lives on the `Session` and is never written to disk. A permission granted an hour
ago must not be waiting after a restart. `/clear` clears it; `/rewind` does not, because a
rewind is not a new session and the approvals were granted in this run.

Path confinement in `paths.ts` is separate, runs first, and applies to `read_file`,
`write_file` and `edit_file` without exception.

## Not built

Permission **modes** (`read_only`, `approve_for_me`) and the sandbox.

The sandbox is macOS-only (`/usr/bin/sandbox-exec`), built on an API Apple has deprecated, and
only pays off once `approve_for_me` exists. For a portable CLI the classifier may be the better
permanent answer.

If `classify.ts` grows past ~200 lines, stop: the extra cases belong in the rules file, where
the user writes them, not in code.
