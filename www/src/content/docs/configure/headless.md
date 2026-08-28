---
title: Print mode
description: Running acc without a terminal — the -p flag, what lands on stdout and stderr, the exit code, why confirms are denied by default, and the two caps that bound an unattended run.
sidebar:
  order: 7
---

`acc -p "list the files you can see"` runs one turn and exits. There is no
terminal UI, no keyboard, and no TTY needed — it is the same agent, driven by a
script instead of by you.

```sh
acc -p "what does src/core/loop.ts do?"
```

The answer goes to stdout and nothing else does, so a redirect is useful:

```sh
acc -p "summarize the README" > summary.txt
```

Tool lines, every confirm with the decision it got, and the reason a run stopped
early all go to stderr. Nothing else is on stdout — no welcome header, no MCP
warnings, no notices.

## It refuses to change anything, unless you say so

A print run answers every permission prompt with **no**. The model can read and
search; the moment it tries a write, a delete, or a command that reaches outside
the workspace, the gate asks, print mode denies, and the tool comes back
refused.

`--yes` flips that to yes:

```sh
acc -p "add a CHANGELOG entry for v2" --yes
```

`--yes` approves each call **once**. It never remembers one, so the gate is
asked again the next time and every ask is recorded. The count of prompts a run
made comes back in `--json` output, approved or refused — approving is not the
same as not asking.

Deny is the default because a script that quietly gained write access to your
workspace is worse than a script that stopped and told you it needed one.

## It cannot run forever

Two caps, and both are on:

- **20 steps.** The loop asks permission to continue every 20 steps. A print run
  always denies that, `--yes` included, so 20 is a real ceiling.
- **300 seconds**, changed with `--max-seconds`. The timer aborts the run, and
  the abort is honoured between steps — a single very long tool call can overrun
  it and stop at the next step boundary.

```sh
acc -p "run the tests and tell me what failed" --yes --max-seconds 900
```

## The exit code

`0` when the turn finished. `1` when it stopped early — a denied prompt, a cap,
or an error.

A non-zero exit means **the run did not complete**. It is not a judgement about
the answer; nothing here reads the answer.

```sh
acc -p "check the build" || echo "did not finish"
```

## Machine-readable output

`--json` moves the whole event stream to stdout: one JSON object per event, in
order, then one final summary line.

```sh
acc -p "list the tools" --json
```

```json
{"type":"tool_start","id":"call_1","name":"read_file","args":{"path":"README.md"}}
{"type":"tool_end","id":"call_1","name":"read_file","result":"…","diff":null}
{"type":"text_delta","text":"There are five tools."}
{"type":"turn_end","usage":{"prompt":1840,"completion":96,"total":1936}}
{"kind":"result","stopped":"done","usage":{"prompt":1840,"completion":96,"total":1936},"prompts":0,"steps":1}
```

Every line parses on its own. The event lines carry a `type`; the one summary
line carries a `kind` instead, so the two never blur together.

| Field on the `result` line | What it says |
|---|---|
| `stopped` | `done`, `denied`, `timeout`, or `error` — why the run ended. |
| `usage` | Prompt, completion and total tokens for the whole run. |
| `prompts` | How many permission confirms the run was asked, whatever the answer. |
| `steps` | How many tool calls the run made. |

## The flags

| Flag | What it does |
|---|---|
| `-p`, `--print <task>` | Runs `<task>` as one turn and exits. Everything else here needs it. |
| `--json` | Puts the event stream on stdout instead of the answer. |
| `--yes` | Approves each permission prompt once. Never remembers one. |
| `--max-seconds <n>` | Wall-clock cap. Default 300. Must be a positive number. |

`--json`, `--yes` and `--max-seconds` all fail without `-p`, naming print mode —
a flag that was silently ignored is how you come to believe a run was approved
when it was not.

The workspace is the current directory, exactly as in
[interactive mode](/start/install). There is no flag to point it somewhere
else.

## No session is saved

A print run writes nothing under `~/.acc/projects/`, so it cannot be reopened
with [`/resume`](/configure/commands). A harness running dozens of one-turn runs
would otherwise fill the store with sessions nobody will ever reopen.

## Full reasoning

- [`docs/headless.md`](https://github.com/Xuxyyy/terminal-coding-agent/blob/main/docs/headless.md)
  — why the default is deny, why a silent auto-approve is forbidden, why both
  caps are needed, and how the TTY guard was narrowed without loosening it.
