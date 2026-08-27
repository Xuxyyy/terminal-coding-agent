---
title: Settings
description: The two settings.json files acc reads, what a whole one looks like, the environment variables, and why a broken file stops startup instead of loading half of it.
sidebar:
  order: 1
---

`acc` reads two settings files at startup:

1. `~/.acc/settings.json` — yours, for every project
2. `<workspace>/.acc/settings.json` — the project's

Both are optional and both are hand-written. Neither is reloaded while `acc`
runs, so a change needs a restart. Setting `ACC_HOME` moves the first one.

A project's file can only ever make `acc` stricter. The three keys that could
make it more permissive — `permission_mode`, `model`, and `mcpServers` — are
read from your own file only, and each page below says so where it matters.

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

Everything is optional.

| Key | What it does | Where it is documented |
|---|---|---|
| `permission_mode` | How much runs without asking. | [Permissions](/configure/permissions) |
| `permissions` | The `allow`, `ask`, and `deny` rule lists. | [Permissions](/configure/permissions) |
| `model` | Which of the six models to start on. | [Models](/configure/models) |
| `mcpServers` | Servers to spawn, and which of their tools to publish. | [MCP](/configure/mcp) |

Unknown keys at the **top level** are ignored, so you can keep notes there.
Unknown keys *inside* `permissions` or inside a server block are startup errors —
those are the places where a typo would silently cost you a rule you believed
was active.

## Environment variables

| Variable | What it does |
|---|---|
| `ACC_MODEL` | Forces one model id instead of letting `acc` choose. See [Models](/configure/models). |
| `ACC_HOME` | Moves the `acc` folder off `~/.acc` — sessions, settings, and `.env` all follow it. |
| `ACC_COMPACT_AT` | The fraction of the context window at which `acc` starts shrinking the conversation. Defaults to `0.8`. |

`ACC_COMPACT_AT` is only accepted when it reads as a number greater than 0 and
no greater than 1. Anything else — a word, a negative, `1.5` — is ignored
silently and `0.8` is used.

Your API key is not set here. It comes from a `.env` file — see
[Models](/configure/models).

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
