---
title: MCP
description: How acc spawns MCP servers, the mcpServers block and its five keys, the tools allowlist that keeps a big server from spending your context window, and why every MCP call asks before it runs.
sidebar:
  order: 6
---

`acc` ships with six tools. An MCP server is how you give it more without
touching its code: you name a command in your settings file, `acc` spawns it at
startup, and the tools it offers join the [built-in six](/configure/tools) for
the rest of the session, named `mcp__<server>__<tool>`.

`acc` is the **client** half of the [Model Context Protocol](https://modelcontextprotocol.io)
only — it uses other people's servers and never exposes its own six tools to
anything else. Servers are reached over stdio, meaning a local process it
spawns; [hosted servers over HTTP](#not-built-yet) are not built.

## `mcpServers`

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

Each server takes five keys and no others. Any other key is a startup error
naming the five that are valid.

| Key | Required | What it is |
|---|---|---|
| `command` | yes | The executable to spawn. A non-empty string. |
| `args` | no | An array of strings, passed to it. |
| `env` | no | An object of strings, added to its environment. |
| `enabled` | no | `false` means never spawn this server. Default `true`. |
| `tools` | no | An array of patterns. Only the tools they match are published. Default: publish everything. |

This block is read from **`~/.acc/settings.json` only**; finding it in a
project's `.acc/settings.json` is a startup error naming the user file. A
project-level server list would mean that cloning a repository and running `acc`
in it starts whatever process a stranger wrote — before the model has said a
word, and before the gate has anything to gate, because servers start at boot.

### `${VAR}`

`${VAR}` in an `args` entry or an `env` value is replaced with that environment
variable, so your token stays out of a file you might paste into an issue. It is
**not** expanded in `command`, and not in `tools`.

If the variable is not set, `acc` does not start, and the error names the
variable. A server that silently received an empty token would connect, list its
tools, and then fail every call with an opaque error instead.

### `tools`

An **allowlist**: the patterns name what to publish, and everything else the
server listed is dropped.

```json
{"github": {"command": "gh-mcp", "tools": ["list_*", "get_file"]}}
```

A tool costs window. Its name, description, and argument schema are text in the
prompt, sent again on **every turn**. Five built-in tools are a rounding error;
the GitHub server offers forty-five, mostly ones you were never going to use.
[`/context`](/configure/commands) shows what that costs.

`*` means any run of characters — the same glob as `bash(...)` in the
[permission rules](/configure/permissions). A pattern matches the **remote**
name, without the `mcp__github__` prefix: you write `list_issues`, and the model
is offered `mcp__github__list_issues`. An empty array publishes nothing from that
server, which is legal and sometimes what you want.

To write one, run the server unfiltered first:

1. Add the server with no `tools` key and start `acc`.
2. Run `/mcp <server>` to print the tool names it actually offers.
3. Add a `tools` list naming the ones you want, and restart.

`/mcp` then reads `github — ready, 6 of 45 tools`, so you can always see what you
narrowed. **A pattern that matches nothing is not a startup error** — tool names
change between releases, and a stale entry should not stop `acc` launching — but
it is not silent either. It is named on that server's line:

```
github — ready, 6 of 45 tools (no tool matches "list_isues")
```

Two properties are worth keeping in mind. It is an allowlist rather than a
denylist so that a server which adds twelve tools in its next release cannot
quietly spend your window on all twelve. And **`tools` is not a permission**:
narrowing the list changes which tools the model is *shown*, never which calls
run without your say-so. Everything you publish still asks.

### `enabled`

`"enabled": false` means the server is **never spawned**: no process, no startup
wait, no tools in the prompt. The block stays in your settings file for when you
want it back, and `/mcp` still lists it as `scratch — disabled` rather than
hiding it.

## Permissions

**Every MCP call asks before it runs.** There is no mode, and no rule you can
write, that makes a server's tool silent.

The [gate](/configure/permissions) works by reading what an action does — a shell
command, or the path a write is aimed at. An MCP call is neither. It is a name
the server chose and an argument object against a schema the server also wrote,
so classifying it would mean deriving a verdict from a string a third party
controls: `delete_everything` would read as dangerous and `helper` as safe, and a
hostile server picks the safe-sounding name for free. The gate declines to have
an opinion, and says so in the prompt.

Saying yes is still remembered, but per **tool**, not per server. Approving a
server's read-only tool tells `acc` nothing about the one that writes; that one
asks on its own the first time it is used.

## When a server fails

Servers are started in parallel at boot and each one is allowed to fail on its
own. A server that is not installed, does not speak the protocol, or never
answers is recorded as failed with the reason, contributes no tools, and is
otherwise ignored. The others keep theirs and `acc` starts normally — a stale
entry in a settings file should not stop the whole tool from launching.

[`/mcp`](/configure/commands) is where a failure becomes visible, one line per
server: ready with a tool count, filtered with both counts, disabled, or failed
with the reason. `/mcp <server>` prints one server's tool names.

Servers connect once at startup, so a change to the block needs a restart, and a
server that dies mid-session stays dead until one.

## Not built yet

| | Waiting on |
|---|---|
| Hosted servers over HTTP | Not the transport, which is a swap — OAuth: a browser round trip, a token store, refresh, and revocation, none of which this project has anywhere else. |
| Resources and prompts | An answer to who decides a resource enters the context window and what it displaces. That is a context-management design, not a protocol one. |
| Rules that pre-approve MCP tools | A considered design. Session approval is deliberately the only memory an MCP call has; a rule in a file is standing trust, which is what this page is arranged to avoid. |
| Excluding tools with `!pattern` | Someone wanting *everything except three*. Nobody has asked. |
| Reconnecting without a restart | A policy for when to retry and what the model is told meanwhile — more of the work than the reconnecting is. This is a gap, not a position. |
| Per-project servers | Nothing. Refused on purpose, for the reason under [`mcpServers`](#mcpservers). |

## Full reasoning

- [`docs/mcp.md`](https://github.com/Xuxyyy/terminal-coding-agent/blob/main/docs/mcp.md)
  — the path from a line of JSON to a tool the model can call, the permission
  branch line by line, and how the round trip is tested against a real server.
