---
title: Models and keys
description: The three providers acc supports, the six model ids and their context windows, and where it reads your API key from.
sidebar:
  order: 2
---

`acc` talks to three providers through one OpenAI-compatible client. You need a
key for **one** of them.

## Providers and keys

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
   used. The [`/model`](/reference/commands#model) picker writes that key, so a
   model you switch to is still there tomorrow.
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
[Your first run](/start/first-run).

## Environment variables

| Variable | What it does |
|---|---|
| `ACC_MODEL` | Forces one model id instead of letting `acc` choose. |
| `ACC_HOME` | Moves the `acc` folder off `~/.acc` — sessions, settings, and `.env` all follow it. |
| `ACC_COMPACT_AT` | The fraction of the context window at which `acc` starts shrinking the conversation. Defaults to `0.8` — see [Context](/guide/context). |

`ACC_COMPACT_AT` is only accepted when it reads as a number greater than 0 and
no greater than 1. Anything else — a word, a negative, `1.5` — is ignored
silently and `0.8` is used.
