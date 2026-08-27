---
title: Settings and models
description: The settings.json files, the allow/ask/deny rules, the pattern syntax, the three providers and six model ids, and where your API key is read from.
sidebar:
  order: 3
---

`acc` reads two settings files at startup:

1. `~/.acc/settings.json` — yours, for every project
2. `<workspace>/.acc/settings.json` — the project's

Both are optional and both are hand-written. Neither is reloaded while `acc`
runs, so a change needs a restart. [The permission gate](/design/permissions) is the
reasoning behind these rules; this page is the syntax.

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
  },
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {"GITHUB_TOKEN": "${GITHUB_TOKEN}"}
    }
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

**The list a pattern sits in wins.** The three lists are read in one fixed
order — `deny`, then `ask`, then `allow` — and the first list with *any*
matching pattern decides. How wide or narrow a pattern is never enters into it.

So with:

```json
{
  "permissions": {
    "deny":  ["bash(*)"],
    "allow": ["bash(git *)"]
  }
}
```

`git status` is **denied**. `bash(*)` matches it, `deny` is read first, and the
`allow` is never reached. A blanket `deny` is a wall, and no narrower `allow`
written below it — or added later by someone who never read the `deny` — can
cut a door in it.

**`ask: ["bash(*)"]` means ask about everything.** It does *not* mean *ask about
whatever is not listed below*. It matches every command and is read before
`allow`, so it silences every `allow` rule in the file. To ask about the rest,
write **no rule** and let the classifier decide — that is what the classifier is
for.

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
[Commands](/reference/commands). Absent everywhere means `auto-edits`.

**It is read from `~/.acc/settings.json` only.** The same key in a project's
`.acc/settings.json` is a startup error naming that file — a repository you
cloned must not be able to make your agent permanently more permissive.

`/permission` writes this same key, so what you read in the file is always what
is live.

## `model`

```json
{ "model": "deepseek-v4-flash" }
```

One of the six model ids listed under [Models](#models) below. Absent everywhere
means `acc` falls back to the first provider key it finds.

**It is read from `~/.acc/settings.json` only**, the same rule
`permission_mode` follows. The key in a project's `.acc/settings.json` is a
startup error naming the user file, and an unknown id is a startup error listing
the six valid ones.

[`/model`](/reference/commands) writes this key, so what you read in the file is
always what the next run starts on. `ACC_MODEL` still wins over it.

## `mcpServers`

Servers that speak the [Model Context Protocol](https://modelcontextprotocol.io).
Each one is a command `acc` spawns at startup; the tools it offers join the
built-in five for the rest of the session.

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {"GITHUB_TOKEN": "${GITHUB_TOKEN}"},
      "tools": ["list_*", "get_file"]
    },
    "notes": {
      "command": "/usr/local/bin/notes-mcp"
    },
    "scratch": {
      "command": "scratch-mcp",
      "enabled": false
    }
  }
}
```

The name on the left — `github`, `notes` — is yours. It may use letters, digits,
dashes and underscores, and nothing else. It prefixes every tool that server
offers, so the model sees `mcp__github__list_issues`, and two servers offering
the same tool never collide.

Each server takes five keys and no others:

| Key | Required | What it is |
|---|---|---|
| `command` | yes | The executable to spawn. A non-empty string. |
| `args` | no | An array of strings, passed to it. |
| `env` | no | An object of strings, added to its environment. |
| `enabled` | no | `false` means never spawn this server. Default `true`. |
| `tools` | no | An array of patterns. Only the tools they match are published. Default: publish everything. |

Any other key is a startup error naming the five that are valid.

**It is read from `~/.acc/settings.json` only**, the same rule `permission_mode`
and `model` follow. The key in a project's `.acc/settings.json` is a startup
error naming the user file — a repository you cloned must not be able to spawn a
process on your machine.

### `${VAR}`

`${VAR}` in an `args` entry or an `env` value is replaced with that environment
variable, so your token stays out of a file you might paste into an issue. It is
**not** expanded in `command`.

If the variable is not set, `acc` does not start, and the error names the
variable. A server that silently receives an empty token would connect, list its
tools, and then fail every call with an opaque error instead.

### `tools` — publishing fewer of them

Every tool a server offers is a name, a description, and a JSON schema sitting in
the prompt on **every turn**. A big server is not free: some publish forty or
more, and you can watch what that costs in [`/context`](/reference/commands).
`tools` is how you pay for only the ones you use.

It is an **allowlist**. The patterns name what to publish, and everything else
the server listed is dropped:

```json
{"github": {"command": "gh-mcp", "tools": ["list_*", "get_file"]}}
```

`*` means any run of characters — the same glob as `bash(...)` in the rules
above. A pattern matches the **remote** name, without the `mcp__github__` prefix:
you write `list_issues`, and the model is offered `mcp__github__list_issues`.
`${VAR}` is **not** expanded here; a tool name is not a secret, and a filter that
changed with your environment would be a trap.

The way to write one is to run the server unfiltered first:

1. Add the server with no `tools` key and start `acc`.
2. Run `/mcp <server>` to print the tool names it actually offers.
3. Add a `tools` list naming the ones you want, and restart.

`/mcp` then reads `github — ready, 6 of 45 tools`, so you can always see what you
narrowed. An empty array publishes nothing from that server, which is legal and
sometimes what you want.

**A pattern that matches nothing is not a startup error.** It is reported on that
server's `/mcp` line instead:

```
github — ready, 6 of 45 tools (no tool matches "list_isues")
```

A server's tool list changes between releases, so a name that was right last
month must never stop `acc` from starting — but a typo would otherwise cost you a
tool with nothing on screen saying why.

**`tools` is not a permission.** It decides what the model is *offered*, not what
it is allowed to do. Everything you publish still asks, exactly as below.

### `enabled` — keeping a server without running it

`"enabled": false` means the server is **never spawned**: no process, no startup
wait, no tools in the prompt. The block stays in your settings file for when you
want it back. `/mcp` still lists it:

```
scratch — disabled
```

It is listed rather than hidden on purpose — a server missing from the readout
with nothing saying why is the confusion these keys exist to remove.

### Every MCP call asks

An MCP server is code `acc` did not write, running outside your workspace, so no
permission mode ever runs one of its tools silently — see
[the permission gate](/design/permissions). Answering "yes, and stop asking" is
remembered for that **one tool** for the rest of the session; the same server's
other tools still ask the first time.

Servers connect once at startup, and like everything else on this page a change
needs a restart. [`/mcp`](/reference/commands) shows which ones are up, which are
filtered, and which are disabled; `/mcp <server>` prints one server's tool names.
A server that fails to start is reported and skipped — the others keep their tools
and `acc` runs. [Why it works this way](/design/mcp).

## Providers and keys

`acc` talks to three providers through one OpenAI-compatible client. You need a
key for **one** of them.

| Provider | Environment variable | Sign up |
|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | [platform.deepseek.com](https://platform.deepseek.com) |
| GLM / Z.ai | `GLM_API_KEY` | [z.ai](https://z.ai) |
| Moonshot / Kimi | `MOONSHOT_API_KEY` | [platform.moonshot.ai](https://platform.moonshot.ai) |

## Models

| Model id | Provider | Context window |
|---|---|---|
| `deepseek-v4-flash` | DeepSeek | 262,144 |
| `deepseek-v4-pro` | DeepSeek | 262,144 |
| `glm-5.2` | GLM | 262,144 |
| `glm-4.7-flash` | GLM | 200,000 |
| `kimi-k3` | Kimi | 262,144 |
| `kimi-k2.7-code` | Kimi | 262,144 |

`deepseek-v4-flash` is the default. Every reply is capped at 32,000 output
tokens.

## Where your key is read from

At startup `acc` reads two files, in this order:

1. `.env` in the folder you started it in
2. `~/.acc/.env`

A variable already set in your shell wins over both, and the first file to
define a key wins over the second. So `~/.acc/.env` is the good place for a key
you always want, and a project's own `.env` overrides it when you need
something different there.

The repository ships a `.env.example`. Copy it and fill in one line:

```bash
cp .env.example .env
```

```bash
# .env
DEEPSEEK_API_KEY=sk-...
```

## How the model is chosen

1. If `ACC_MODEL` is set, that model is used.
2. Otherwise, if `"model"` is saved in `~/.acc/settings.json`, that model is
   used. The [`/model`](/reference/commands) picker writes that key, so a model
   you switch to is still there tomorrow.
3. Otherwise, if `DEEPSEEK_API_KEY` is set, the default `deepseek-v4-flash` is
   used.
4. Otherwise the first model whose provider key is present is used.

`ACC_MODEL` stays above the saved model on purpose: an override a settings file
could beat would not be an override.

If the chosen model needs a key you have not set, `acc` stops at startup with
`DEEPSEEK_API_KEY is not set — needed for DeepSeek v4 Flash.` If `ACC_MODEL`
names a model that does not exist, it stops with `Unknown model` and lists the
six valid ids.

The model in use is printed in the header when `acc` starts — see
[Install and first run](/start/install).

## Environment variables

| Variable | What it does |
|---|---|
| `ACC_MODEL` | Forces one model id instead of letting `acc` choose. |
| `ACC_HOME` | Moves the `acc` folder off `~/.acc` — sessions, settings, and `.env` all follow it. |
| `ACC_COMPACT_AT` | The fraction of the context window at which `acc` starts shrinking the conversation. Defaults to `0.8`. |

`ACC_COMPACT_AT` is only accepted when it reads as a number greater than 0 and
no greater than 1. Anything else — a word, a negative, `1.5` — is ignored
silently and `0.8` is used.

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
