# Configuration

## Settings files

ACC reads two optional JSON files at startup:

1. `~/.acc/settings.json` for user settings.
2. `<workspace>/.acc/settings.json` for project permission rules.

Restart ACC after editing them. `ACC_HOME` moves the user settings, sessions,
`.env`, and global agent definitions out of `~/.acc`.

The `permission_mode`, `model`, and `reasoning_effort` keys belong only in the
user file. Putting them in a project file is a startup error. Example user
settings:

```json
{
  "permission_mode": "auto-edits",
  "model": "deepseek-flash",
  "reasoning_effort": "high",
  "permissions": {
    "ask": ["bash(npm run deploy*)"],
    "allow": ["bash(npm test)"]
  }
}
```

All keys are optional. The default permission mode is `auto-edits`; saved modes
remain in effect. Unknown top-level keys are ignored. Bad JSON, invalid values,
invalid rule syntax, or unknown keys inside `permissions` stop startup rather
than silently dropping a rule. See [permissions](permissions.md) for rule
matching, precedence, and the `allow`, `ask`, and `deny` lists.

## Models and API keys

ACC uses `deepseek-flash` through the official DeepSeek Chat Completions API.
The alias currently maps to DeepSeek V4.1 Flash, but an alias alone does not prove
that runs on different dates used the same version.

Set `DEEPSEEK_API_KEY` for coding and Auto mode's permission judge. ACC checks
the shell first, then the project's `.env`, then `<ACC_HOME>/.env`.
Copy the repository's `.env.example` to `.env` and fill in the key if needed.
Keep keys and `.env` files out of Git. Missing coding credentials stop startup;
a failed permission judge falls back to confirmation or the print-mode policy.

The context window is 1,048,576 tokens. Maximum output is 64,000 tokens including
reasoning, and the coding request timeout is 120 seconds. Reasoning defaults to
`high`; `none`, `low`, `high`, and `max` are accepted. `none` disables thinking.
Subagents and compaction inherit the parent's effort. Coding settings do not
change the permission judge's prompt, token limit, or timeout.

| Environment variable | Effect |
| --- | --- |
| `ACC_MODEL` | Overrides the user model setting; `deepseek-flash` is the supported coding model. |
| `ACC_REASONING_EFFORT` | Overrides the user reasoning setting. |
| `ACC_HOME` | Moves ACC's private settings and storage directory. |
| `ACC_COMPACT_AT` | Sets the compaction threshold as a fraction in `(0, 1]`; invalid values fall back to `0.8`. |

The header, saved session metadata, and print-mode JSON report effective model
settings. Legacy sessions without compatible DeepSeek metadata cannot resume;
they are not automatically deleted as part of the migration.

## Named subagents

Create a direct regular Markdown file at `<ACC_HOME>/agents/<name>.md`.
The filename must begin with a lowercase letter or digit and contain only
lowercase letters, digits, dashes, and underscores. Nested files and symlinks
are ignored. Definitions are global, loaded at startup, and need a restart
after edits. Project-local agent definitions are not loaded.

Example `explorer.md`:

```md
---
description: Explores and explains code without editing it
model: deepseek-flash
tools:
  - read_file
  - grep
permission_mode: ask-edits
---

Inspect the repository and report exact file paths and line numbers.
Do not modify files.
```

`description` and a nonempty Markdown body are required. `model`, `tools`, and
`permission_mode` are optional. Unknown fields stop startup. Tool names are
exact and unique; an empty list gives the child no tools. A definition can
narrow the parent's permissions, but cannot widen them. Named agents cannot
override reasoning effort or spawn nested agents.

The parent selects a definition with the `agent` field of the `agent` tool.
Children share the workspace and run in the background by default. Their
history is separate and saved under the parent session. See [agent tools](tools.md#agent)
for tool inheritance, messages, waiting, cancellation, and follow-up assignments.
