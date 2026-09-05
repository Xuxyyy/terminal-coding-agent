---
title: Subagent
description: Define global named subagents with their own model, prompt, tool list, and stricter permission mode.
sidebar:
  order: 4
---

Named subagents let the parent choose a prepared kind of subagent for one job.
Each type has a routing description and role instructions. It may also choose a
model, an exact tool list, and a permission mode that is no wider than the
parent's.

The parent still waits for the child. You see one `agent` row, then the child's
final report returns to the parent. The child's tool rows and working context do
not enter your conversation.

## Where definitions live

Create one Markdown file per type:

```text
<ACC_HOME>/agents/<name>.md
```

`ACC_HOME` defaults to `~/.acc`, so the usual path is
`~/.acc/agents/explorer.md`. Definitions are global and available in every
project. The child always works in the directory where you started `acc`; it
does not work inside the agents directory.

The filename is the type name. It must begin with a lowercase letter or digit
and may contain lowercase letters, digits, dashes, and underscores. Only direct
regular `.md` files are read. Nested files and symlinks are ignored.

Restart `acc` after adding or changing a definition. Files are read once during
startup; there is no hot reload.

## Complete example

Save this as `~/.acc/agents/explorer.md`:

```md
---
description: Explores and explains code without editing it
model: deepseek-v4-flash
tools:
  - read_file
  - grep
permission_mode: ask-edits
---

Inspect the repository carefully.

Report exact file paths and line numbers. Do not modify files.
```

The opening YAML front matter configures the type. The Markdown body is added
after `acc`'s fixed subagent rules. Those rules still require an isolated job,
no questions to the user, and a complete final report.

| Field | Required | Default | What it does |
|---|---|---|---|
| `description` | yes | — | A non-empty routing summary shown to the parent model. |
| `model` | no | parent's current model | One id from [Models](/configure/models). The client is created when this type runs. |
| `tools` | no | every available tool except `agent` | Exact built-in or `mcp__<server>__<tool>` names, in the order written. `[]` gives the child no tools. |
| `permission_mode` | no | parent's current mode | `ask-edits`, `auto-edits`, or `auto`. The child receives whichever is stricter: this value or the parent's mode. |

No other front-matter keys are accepted. Tool names must be unique, non-empty,
and exact; wildcards are not supported. `agent` is refused, so a child can never
start another child.

## How the parent uses a type

When at least one definition loads, the `agent` tool schema gains an optional
`agent` field containing the sorted type names. Each name and its description
is also sent to the parent model. A call can then look like this:

```json
{
  "agent": "explorer",
  "description": "find authentication flow",
  "prompt": "Trace how login authentication works."
}
```

`description` remains the short label in the terminal row. `prompt` remains the
whole delegated job. The type name replaces neither one. Omitting `agent` uses
the general child exactly as before.

## Models, tools, and permissions

A configured model is checked when the file loads, but its provider client is
created only when that type runs. This means a valid definition for a provider
whose key is missing does not stop `acc` from starting. Selecting it returns an
error that names the missing environment variable.

Configured tools are checked against the live registry at invocation time. If
an MCP server is disabled, failed to connect, or did not publish a named tool,
the child does not run with a smaller list. The tool result names every missing
tool so you can fix the file or server.

A definition can narrow permissions but cannot widen them. The order from most
to least strict is `ask-edits`, `auto-edits`, then `auto`. For example, an
`auto` type under an `auto-edits` parent still runs as `auto-edits`; an
`ask-edits` type under either parent runs as `ask-edits`. Every child tool call
still passes through the normal [permission gate](/configure/permissions).

## Startup errors

A malformed file stops startup and prints its full path and exact problem. This
includes missing delimiters, invalid YAML, an empty body or description,
unknown keys, unknown model or mode values, invalid tool lists, and invalid
filenames. Starting with a silently dropped type would give the parent routing
information that does not match what can run.

Missing provider keys and unavailable MCP tools are different: they can change
without changing a valid definition, so they fail only when that type is used.

## Not built

Definitions are not read from `<workspace>/.acc/agents`. Named subagents do not
run in parallel or in the background, spawn nested agents, inherit the parent's
conversation, persist a child session, or show live child progress. There is no
agent editor, picker, `/agents` command, hot reload, or per-agent token, turn,
timeout, temperature, or reasoning setting.
