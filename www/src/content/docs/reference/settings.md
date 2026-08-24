---
title: Settings
description: The settings.json files, the allow/ask/deny rules, the pattern syntax for bash and edit, and which rule wins.
sidebar:
  order: 3
---

`acc` reads two settings files at startup:

1. `~/.acc/settings.json` — yours, for every project
2. `<workspace>/.acc/settings.json` — the project's

Both are optional and both are hand-written. Neither is reloaded while `acc`
runs, so a change needs a restart. [Permissions](/guide/permissions) is the
guide to what these rules do; this page is the syntax.

Setting `ACC_HOME` moves the first one.

## Shape

```json
{
  "permission_mode": "auto-edits",
  "model": "deepseek-v4-flash",
  "permissions": {
    "deny":  ["bash(curl *)"],
    "ask":   ["bash(npm run deploy*)"],
    "allow": ["bash(npm run *)", "bash(git *)"]
  }
}
```

Everything is optional. Inside `permissions` the only keys are `allow`, `ask`,
and `deny`, each a list of strings — any other key is a startup error.

Unknown keys at the **top level** are ignored, so you can keep notes there.

## Rules

A rule is one string, written `tag(pattern)`. There are exactly two tags:

- **`bash(...)`** matches a shell command.
- **`edit(...)`** matches a file path — and it covers **both** `edit_file` and
  `write_file`. There is no `write(...)` tag; writing one is a startup error
  that tells you to use `edit`.

The three lists mean what they say: `allow` runs without asking, `ask` stops and
asks, `deny` refuses outright with no prompt.

```json
{
  "permissions": {
    "deny":  ["edit(**)"],
    "allow": ["edit(plans/**)", "bash(npm run *)"]
  }
}
```

That is a session that may write under `plans/` and nowhere else — narrower than
any permission mode can express, because it names paths.

## Pattern syntax

`*` is the only special character in either tag. `?`, `[a-z]`, and regular
expressions are all literal.

**But `*` means something different in each**, and this is the part to get
right:

| | `bash(...)` | `edit(...)` |
|---|---|---|
| `*` | any run of characters, **spaces included** | any run of characters **except `/`** |
| `**` | nothing special | crosses `/` |

A `bash` pattern is matched against a whole command line, so `bash(git *)` has
to reach the end of it — `*` spanning spaces is what makes that work.

An `edit` pattern is matched like the globs you already know:
`edit(docs/*.md)` is the files directly in `docs/`, and `edit(docs/**)` is the
whole tree under it.

Two special cases:

- **`edit(*)` matches every path**, exactly like `edit(**)`. Under the
  `*`-stops-at-`/` rule it would otherwise mean only the files in the project
  root, leaving `src/` writable while you believed the project was sealed.
  `edit(**)` is the spelling to use.
- **A pattern ending in `/` means the directory and everything under it.**
  `edit(src/)` is `edit(src/**)`. Plain `edit(src)` matches the directory entry
  and nothing inside it, which is never what anyone means.

`edit(docs/**)` does not match the bare `docs` — it is what is *inside* the
directory. A write always names a file, so this costs nothing.

Paths are matched **relative to the workspace root**, after `~` is expanded and
symlinks are resolved. So `src/a.ts`, `plans/../src/a.ts`, and the absolute path
to the same file are one path and one rule.

A `bash` pattern is matched against the command after `acc` normalizes it, so
`npm  run   build` and `npm run build` are the same rule.

## Which rule wins

**The most specific pattern wins**, not the list it sits in. Specificity is the
count of characters in the pattern that are **not** `*`.

So with:

```json
{
  "permissions": {
    "ask":   ["bash(*)"],
    "allow": ["bash(git *)"]
  }
}
```

`bash(git *)` scores 4 and `bash(*)` scores 0, so this means *ask about
everything except git* — which is what it looks like it means.

**A tie goes to the stricter verdict:** `deny` beats `ask` beats `allow`. When
two patterns score the same, the safe answer wins, so a file can never be
quietly more permissive than it reads.

A command with several stages — `npm test && rm -rf build` — is judged by its
**worst** stage. A stage matching no pattern at all counts as worse than
`allow`, which is what stops `bash(git status*)` from carrying
`git status && rm -rf x` through.

## What a rule cannot do

**No `allow` rule can silence an escape.** After the rules produce one verdict,
it enters this chain:

> `deny` rule → escape → `ask` rule → `allow` rule → the classifier

Because escapes sit above every `allow`, no rule you write can stop `acc`
asking about `sudo`, `git push`, `dd of=`, `mkfs`, a fork bomb, or **anything
reaching outside the project**. There is no way to turn those off. If you want
one of them gone entirely, the answer is `deny`, not `allow`.

**A relative pattern never reaches outside the project.** `edit(**)` and
`edit(*)` mean *inside the workspace* and nothing more, so writing
`"deny": ["edit(**)"]` to seal a project does not accidentally seal your home
directory. To name something outside, the pattern must be absolute — starting
with `/` or `~/`, or being exactly `~`:

```json
{ "permissions": { "deny": ["edit(~/.ssh/**)"] } }
```

`deny` is the only verdict that reaches outside the project, and the only one
that governs reads as well as writes.

An `allow` rule *can* reach a protected path — `allow: ["edit(**)"]` reaches
`.git/config` — because naming a path is exactly how you say *I mean this file*.

## `permission_mode`

```json
{ "permission_mode": "auto-edits" }
```

One of `ask-edits`, `auto-edits`, or `auto` — see
[Permissions](/guide/permissions). Absent everywhere means `auto-edits`.

**It is read from `~/.acc/settings.json` only.** The same key in a project's
`.acc/settings.json` is a startup error naming that file — a repository you
cloned must not be able to make your agent permanently more permissive.

`/permission` writes this same key, so what you read in the file is always what
is live.

## `model`

```json
{ "model": "deepseek-v4-flash" }
```

One of the six model ids — see [Models](/start/models). Absent everywhere means
`acc` falls back to the first provider key it finds.

**It is read from `~/.acc/settings.json` only**, the same rule
`permission_mode` follows. The key in a project's `.acc/settings.json` is a
startup error naming the user file, and an unknown id is a startup error listing
the six valid ones.

[`/model`](/reference/commands#model) writes this key, so what you read in the
file is always what the next run starts on. `ACC_MODEL` still wins over it.

## A broken file stops `acc`

Bad JSON, a rule that is not a string, an unknown key inside `permissions`, an
unknown tag, an unknown `permission_mode`, or an unknown `model` all print the
file and the problem and exit 1:

```
error: /Users/you/.acc/settings.json: the rule "write(src/**)" in "permissions.allow" must be written bash(<pattern>) or edit(<pattern>); edit(<pattern>) covers both edit_file and write_file
```

This is deliberate. A settings file grants permissions, so starting with half of
them loaded would mean trusting rules that are not active — and you have just
edited the file, so the error lands while you are still looking at it.
