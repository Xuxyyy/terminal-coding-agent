---
title: Models
description: Three providers and six model ids behind one client, the model key, where your API key is read from, and the order acc uses to pick a model.
sidebar:
  order: 4
---

`acc` talks to three providers through one OpenAI-compatible client. You need a
key for **one** of them.

| Provider | Environment variable | Sign up |
|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | [platform.deepseek.com](https://platform.deepseek.com) |
| GLM / Z.ai | `GLM_API_KEY` | [z.ai](https://z.ai) |
| Moonshot / Kimi | `MOONSHOT_API_KEY` | [platform.moonshot.ai](https://platform.moonshot.ai) |

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

## `model`

```json
{ "model": "deepseek-v4-flash" }
```

One of the six ids above. Absent everywhere means `acc` falls back to the first
provider key it finds.

**It is read from `~/.acc/settings.json` only.** The key in a project's
`.acc/settings.json` is a startup error naming the user file, and an unknown id
is a startup error listing the six valid ones.

[`/model`](/configure/commands) writes this key, so what you read in the file is
always what the next run starts on. `ACC_MODEL` still wins over it.

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
   used. The [`/model`](/configure/commands) picker writes that key, so a model
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
[Install](/start/install).
