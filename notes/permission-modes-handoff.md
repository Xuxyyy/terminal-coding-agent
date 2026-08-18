# Permission modes — handoff

## Goal

Explore what `read_only` and `approve_for_me` should be, and produce a plan for
building one of them. Exploring is the task; nothing is designed yet.

## Status

- Branch `main`, at `36f4e10`. The settings-rules slice is merged (4 commits,
  `4d5b818`..`36f4e10`) and **4 commits ahead of `origin/main` — not pushed.**
- `npm test` — 438 tests, 438 pass, 0 fail.
- Uncommitted: `docs/` only, and that is deliberate — see **Decided**.
- Branch `settings-rules` still exists at the same commit as `main`. Safe to
  delete, kept for now.
- `plans/` is empty. The settings-rules plan shipped and was deleted.

## Start here

**Do not edit anything yet.** Read `docs/permissions.md` end to end first — it is
current as of this slice and describes the layer as it actually is. Then read
`src/core/permission/decide.ts` (67 lines) and `src/core/settings.ts` (99 lines);
between them they are the whole surface a mode would plug into. Only then propose
what you intend to do, and wait for the user's answer. The user wants to *discuss*
the design of modes before any code is written, so a plan file or a code change
offered before that conversation is the wrong move.

## How it works today

The single gate is `permitted()` — [registry.ts:64](src/core/tools/registry.ts#L64).
Every tool passes through it. It calls `decide()` and turns the `Outcome` into a
`ConfirmRequest`.

`decide(request, root, rules?)` — [decide.ts:41-67](src/core/permission/decide.ts#L41-L67)
— resolves a command in this order:

1. `ruleVerdict` says `deny` → `decision: 'deny'`, never suppressible ([decide.ts:51-53](src/core/permission/decide.ts#L51-L53))
2. the classifier says `escape` → today's outcome, the rule is dropped ([decide.ts:54-57](src/core/permission/decide.ts#L54-L57))
3. `ruleVerdict` says `ask` or `allow` → that, suppressible ([decide.ts:58-65](src/core/permission/decide.ts#L58-L65))
4. otherwise the classifier decides ([decide.ts:66](src/core/permission/decide.ts#L66))

For `kind: 'write'` the rules are ignored entirely ([decide.ts:46-48](src/core/permission/decide.ts#L46-L48)).

Supporting facts a mode will touch:

- `Rules = {allow, ask, deny}` — patterns only, `bash(` `)` already stripped
  ([settings.ts:5](src/core/settings.ts#L5)).
- `ruleVerdict` — [rules.ts:32-45](src/core/permission/rules.ts#L32-L45). `deny`/`ask`
  fire on any stage; `allow` needs every stage. Unparseable command → never allowed.
- `matchPattern` — [rules.ts:6-12](src/core/permission/rules.ts#L6-L12). `*` is the
  only metacharacter.
- `outcomeFor` — [decide.ts:21-31](src/core/permission/decide.ts#L21-L31). Allows
  `observe` and `recoverable` ([decide.ts:18](src/core/permission/decide.ts#L18));
  `suppressible` is `level !== 'escape'`.
- `Level` is `observe | recoverable | protected | destroy | escape` —
  [classify.ts:11](src/core/permission/classify.ts#L11).
- **`decision: 'deny'` is now a live, tested path**, handled at
  [registry.ts:73](src/core/tools/registry.ts#L73). This is the main thing this
  slice bought the mode work.
- Rules reach the gate as session state: `Session.rules`
  ([session.ts:22](src/core/session.ts#L22)), set from `rulesOf()` at
  [session.ts:40](src/core/session.ts#L40), passed down at
  [loop.ts:228](src/core/loop.ts#L228), required on `ToolContext`
  ([registry.ts:11](src/core/tools/registry.ts#L11)).
- `clearSession` clears `allowed` but **keeps `rules`** —
  [session.ts:79-84](src/core/session.ts#L79-L84).
- Settings load once at boot, before the TTY check
  ([cli.tsx:12](src/cli.tsx#L12), [headless.ts:60](src/headless.ts#L60)) from
  `$ACC_HOME/settings.json` then `<workspace>/.acc/settings.json`
  ([settings.ts:16-21](src/core/settings.ts#L16-L21)).

**The user's real `~/.acc/settings.json` contains `"permission_mode": "approve_for_me"`
and nothing reads it.** Verified: `grep -rn "permission_mode" src/` hits only a test
fixture. It parses to empty rules and is ignored by design
([settings.ts:27-45](src/core/settings.ts#L27-L45)). So the file already *looks*
like a mode is set. That is the strongest single argument for doing modes next.

## Decided — do not re-argue

- **Guardrails always win.** `deny` rule > escape > `ask` rule > `allow` rule >
  classifier. No allow rule can silence `sudo`, `git push`, `dd of=`, `mkfs*`, a
  fork bomb, or anything outside the project. *Why:* an escape can never be
  remembered, and a file that could silence one would make that guarantee false.
  Accepted cost: no way to stop `acc` asking about `git push`.
- **Only `bash(...)` rules exist.** `write_file`/`edit_file` stay classifier-driven
  because an edit-specific mode is meant to own that surface. Two systems deciding
  one thing is the bug.
- **The tool tag is required in the syntax.** Any other tag is a startup error.
  This is the extension point: `write(...)`/`edit(...)` slot in with no format
  migration.
- **A broken settings file refuses to start** (exit 1, file named). Ignoring a typo
  means believing in rules that are not active.
- **Unknown top-level keys are ignored silently**; strictness applies only inside
  `permissions`. This is what lets `permission_mode` sit in the file today.
- **Rules load once at boot, never reload.** Editing needs a restart, so a session's
  behaviour stays explainable.
- **`/permissions`, a command that writes rules for you, was rejected on 2026-08-17.**
  The file is hand-written. A live run confirmed hand-editing works; whether it is
  *pleasant* is still the user's call.
- **`docs/` stays untracked** (decided 2026-08-17). It has never been tracked in this
  repo's history and `CLAUDE.md` says so. The rewrites live in the working tree only.

## Plan

**None. Nothing is planned or implemented for modes.** Do not treat the leads below
as a plan — they are the previous slice's notes on what it made cheaper:

- `read_only` could be a **rule generator** — deny everything that is not a read —
  rather than new plumbing, because `'deny'` is already live and tested.
- A mode would most naturally arrive as a top-level `settings.json` key, since the
  file, loader and strict validator already exist.
- `approve_for_me` is the one the previous slice tied to the sandbox, which is
  macOS-only and built on an API Apple deprecated (`docs/permissions.md:200-208`).

## Open questions — for the user

1. `read_only` or `approve_for_me` first? They are different in kind: one removes
   permissions, the other grants them.
2. Is a mode a **rule generator** that feeds the existing `Rules`, or a separate
   layer inside `decide()`? This decides whether `decide()` grows a parameter.
3. `permission_mode` is currently ignored as an unknown top-level key. Once it is
   read, an unrecognised *value* needs an answer: refuse to start, like a bad rule,
   or ignore it?
4. Does `approve_for_me` need the sandbox to be honest, or is the classifier enough?
5. Should `main` be pushed, and should the `settings-rules` branch be deleted?

## Verify

```sh
npm test                                   # 438 tests, 438 pass, 0 fail
node --test dist/tests/core/settings.test.js
node --test dist/tests/core/permission/rules.test.js
```

The boot refusal, run from a temp directory, never from this repo:

```sh
tmp=$(mktemp -d) && mkdir -p "$tmp/home" && printf '{bad' > "$tmp/home/settings.json"
(cd "$tmp" && ACC_HOME="$tmp/home" node /Users/xuxyyy/Desktop/coding-cli/dist/cli.js; echo "exit=$?")
# exit=1, stderr names settings.json, and must NOT say "interactive mode requires a terminal"
```

A live run on 2026-08-17 (DeepSeek v4 Flash, ~12,900 tokens) confirmed on a real
terminal: `python3 hello.py` prompts with no rule, does not prompt with
`bash(python3 *)` allowed, still does not prompt after a restart, and `sudo ls`
still prompts non-suppressibly even with `bash(*)` allowed. One gap, unverified
live: that the *pattern* matched rather than a blanket allow — covered at unit
level in `src/tests/core/permission/rules.test.ts` only.

Note for any live check: the terminal screen alone gives false passes. After a
denial the model may read the file and print the expected output anyway. Read the
tool record in `session.jsonl` instead.

## Out of scope

- The edit mode and `write(...)`/`edit(...)` rules — a separate slice that owns the
  file-write surface.
- The sandbox.
- `/permissions` or any command that writes rules for the user — rejected.
- Persisting `ctx.allowed`. Pressing `a` still dies with the run, on purpose.
- `src/core/permission/classify.ts`, `stages.ts`, `harden.ts`, `protected.ts` — the
  classifier is correct; this layer sits on top of it.
