# acc

[![test](https://github.com/Xuxyyy/terminal-coding-agent/actions/workflows/test.yml/badge.svg)](https://github.com/Xuxyyy/terminal-coding-agent/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A terminal coding agent built from scratch in TypeScript. Describe a task in
plain English; `acc` searches your project, edits files, and runs commands.

Includes permission checks, resumable interactive sessions, automatic context
compaction, background commands, and subagents.

<p align="center">
  <img src="assets/demo.png" width="720" alt="acc adding a field to a health route, showing its tool calls and the diff it wrote">
</p>

## Quick start

Requires Node 22+, macOS or Linux (Windows through WSL), and
[ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on your `PATH`.

Set `DEEPSEEK_API_KEY` in your shell before starting. Alternatively, copy
`.env.example` to `.env` in your project and fill in the key. ACC uses
DeepSeek V4.1 Flash (`deepseek-flash`) through the official API, with `high`
reasoning by default. See [model settings](https://coding-cli-docs.vercel.app/configure/models/).

```bash
git clone https://github.com/Xuxyyy/terminal-coding-agent.git
cd terminal-coding-agent
npm install
npm link
cd ~/some-project
acc
```

`npm install` builds the CLI automatically. ACC is not published on npm.

**The workspace is the current directory.** Run `acc` inside your project;
it takes no path argument and refuses to start in your home directory or the
filesystem root. Describe your task at the interactive prompt.

## Behavior and limits

- **ACC edits files and runs shell commands.** The default `auto-edits` mode
  allows ordinary project edits and asks for approval above its automatic
  allowance threshold. A saved permission mode takes precedence.
- **Sandbox defaults to Off.** Permission checks still apply, but ACC's OS file
  and network restrictions do not. Sandbox On is supported only on macOS;
  enable it with `acc --sandbox on` or `/sandbox`. See [sandbox details](docs/sandbox.md).
- **Recovery is limited.** `/resume` reopens interactive sessions. `/rewind`
  restores conversation and file-tool backups; it does not undo shell changes.
- **Subagents run in the background by default.** They share your workspace,
  keep separate conversations, and support messages and saved follow-ups.
  See [subagents](https://coding-cli-docs.vercel.app/configure/subagent/).

See [commands](https://coding-cli-docs.vercel.app/configure/commands/) for
session and context controls, and [feature status](docs/features.md) for
current capabilities and known limits.

## Print mode

Run one task without an interactive terminal:

```bash
acc -p "summarize this project" --max-steps 120 --max-seconds 300
```

Defaults: **120 model turns** (including the final answer) and **300 seconds**.
Add `--json` for structured events and a final result. Confirmations are denied
unless `--yes` is passed; actions already allowed by the permission gate can
still edit files. Print runs do not save resumable sessions.
See [print mode](docs/headless.md) for details.

## Evaluation

### Terminal-Bench 2.1

Latest task outcomes as of **October 24, 2026**, using Harbor and DeepSeek
V4.1 Flash (`deepseek-flash`, high reasoning):

| Outcome | Tasks |
| --- | ---: |
| Automated verifier pass | 78 |
| Fail | 11 |
| Total attempted | 89 |

**78/89 automated verifier passes (87.6%).** These latest per-task results
include reruns across multiple ACC source versions, rather than a single
fixed-version `pass@1` measurement.

ACC ran with `auto-edits`, automatic confirmation enabled, and sandbox off.
Some task environments had dependencies prepared before agent execution.
These results describe that evaluation setup; they do not measure interactive
approval behavior or sandbox protection.

See [Evaluation](https://coding-cli-docs.vercel.app/design/evaluation/) for
methodology, permission-judge checks, and package/CLI checks.

## Docs

Full documentation is at
[coding-cli-docs.vercel.app](https://coding-cli-docs.vercel.app).

- [Install](https://coding-cli-docs.vercel.app/start/install/)
- [Architecture](https://coding-cli-docs.vercel.app/design/architecture/)
- [Commands](https://coding-cli-docs.vercel.app/configure/commands/)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
