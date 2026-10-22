---
title: Models
description: DeepSeek coding, reasoning settings, and permission judging.
sidebar:
  order: 5
---

ACC uses the official DeepSeek Chat Completions API at `https://api.deepseek.com`.
`deepseek-flash` is its only coding model. As of October 13, 2026, this alias maps
to DeepSeek V4.1 Flash. The alias can change, so matching the ID alone does not
prove that runs made at different dates used the same model version.

| Setting | Effective default |
|---|---|
| Coding model | `deepseek-flash` |
| Context window | 1,048,576 tokens |
| Reasoning effort | `high` |
| Thinking | enabled; disabled when effort is `none` |
| Maximum output | 64,000 tokens, including reasoning |
| Request timeout | 120 seconds |
| Permission judge | `deepseek-flash`, with a separate prompt and token limit |

Tools execute locally under ACC's existing permission and sandbox rules.
ACC keeps conversation history locally and sends it with each coding request.
Reasoning is kept for later requests and saved sessions, but is not displayed.

## API keys

Set `DEEPSEEK_API_KEY` for coding and Auto mode's permission judge. A missing
key stops startup. An unavailable judge keeps the existing fallback to human
confirmation or the headless approval policy.

Create a DeepSeek key at [DeepSeek Platform](https://platform.deepseek.com/).
ACC reads the shell first, then the project's `.env`, then `~/.acc/.env`.
Copy `.env.example` to `.env`, fill in the key, and keep that file out of Git.

## Model and reasoning selection

`ACC_MODEL` overrides the user `model` setting; the default is `deepseek-flash`.
Unsupported saved model selections, named-agent model fields, and explicit
`ACC_MODEL` values are rejected. `/model` remains available with one choice.

`ACC_REASONING_EFFORT` overrides the user `reasoning_effort` setting; the default
is `high`. Supported values are `none`, `low`, `high`, and `max`. `none` disables
thinking. Invalid values stop startup. Both settings belong in the user settings
file, not a project's settings file.

```json
{
  "model": "deepseek-flash",
  "reasoning_effort": "high"
}
```

```bash
ACC_MODEL=deepseek-flash ACC_REASONING_EFFORT=high acc
ACC_MODEL=deepseek-flash ACC_REASONING_EFFORT=low acc -p "Explain this project" --json
```

Subagents always inherit the parent's reasoning effort, including named agents.
Compaction uses the same setting. Coding settings never change the judge's
prompt, token limit, or timeout.

The interactive header, saved session metadata, and headless JSON result show
the effective model, reasoning effort, and output limit. The JSON `modelSettings`
object also records the provider, base URL, thinking mode, and request timeout.
These are the values to match in a future comparison; ACC does not configure
Codex or run benchmarks for you.

## Sessions from before the migration

Start a fresh DeepSeek session. Legacy sessions without compatible DeepSeek
metadata cannot resume. They remain stored unless explicitly deleted; ACC does
not automatically delete them during startup as part of this migration.

See [DeepSeek's model details](https://api-docs.deepseek.com/quick_start/pricing/)
and [reasoning controls](https://api-docs.deepseek.com/guides/thinking_mode/).
