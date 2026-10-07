---
title: Models
description: Gemini model choices, API key setup, and how acc selects a model.
sidebar:
  order: 5
---

`acc` uses the native Gemini Interactions API. It keeps conversation history
locally and sends it with each request using `store: false`. It does not use a
Google-hosted agent. File and shell tools still run on your computer.

| Model id | Role | Context window |
|---|---|---:|
| `gemini-3.8-flash` | Default | 1,048,576 tokens |
| `gemini-3.1-pro-preview` | Optional | 1,048,576 tokens |
| `gemini-3.5-flash-lite` | Permission judge; also selectable | 1,048,576 tokens |

Every reply is capped at 32,000 output tokens.
Permission checks in `auto` mode use Gemini 3.5 Flash-Lite regardless of the main
agent's selected model, with the same API key and no separate setting.

## API key

Create a key in [Google AI Studio](https://aistudio.google.com/apikey) and set
`GEMINI_API_KEY`. `acc` checks your shell first, then `.env` in the current
project, then `~/.acc/.env`.

```bash
cp .env.example .env
```

Fill in the key in `.env`. Keep that file private and out of Git.

## Model selection

`acc` uses `ACC_MODEL` if it is set. Otherwise it uses the model saved in
`~/.acc/settings.json`. Otherwise it starts with `gemini-3.8-flash`.

Use [`/model`](/configure/commands) to switch models and save your choice.
The saved setting has this form:

```json
{ "model": "gemini-3.1-pro-preview" }
```

A model setting in a project's `.acc/settings.json` is a startup error; the
setting belongs in the user file. Old DeepSeek and Kimi model settings are
ignored after this update. If the selected model is unknown or the Gemini key
is missing, `acc` stops with a clear error.
