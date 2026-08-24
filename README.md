# acc

A small terminal coding agent that reads, edits, and runs code in the current
directory.

<!-- demo: replace with ![acc](assets/demo.gif) -->

## Quick start

```bash
git clone https://github.com/Xuxyyy/coding-cli.git
cd coding-cli
npm install   # prepare runs tsc, so there is no separate build step
npm link
cd ~/some-project
acc
```

**The workspace is the current directory.** `acc` reads, edits, and runs code in
the folder you start it from. It takes no path argument and no flags.

## Requirements

- Node 22 or newer.
- ripgrep (`rg`) on your `PATH`, for the `grep` tool. Without it the agent falls
  back to shell `grep` — that works, but it is slower and ignores `.gitignore`.

## API keys

One key is enough. Copy `.env.example` to `.env` and fill in DeepSeek, GLM, or
Kimi; `acc` picks a model from whichever key it finds. The six model ids are on
[Models and keys](https://coding-cli-docs.vercel.app/start/models/).

## What it can do

- Five tools: `read_file`, `grep`, `edit_file`, `write_file`, and `bash`.
- Three providers — DeepSeek, GLM, and Kimi — six models between them.
- Sessions you can resume and rewind. `/resume` reopens an earlier run;
  `/rewind` goes back to before a message you sent, restoring the files it
  touched.
- One permission gate that every tool call passes through.
- A context readout: `/context` prints how full the window is, with a breakdown.

## Architecture

**The seam.** `src/core` runs the agent and never imports React; `src/ui` draws
it with Ink. They meet at one interface, `Host` in `src/core/host.ts`, which is
three members: `confirm`, `onEvent`, and `signal`. No import points the other
way, so the turn loop is tested without ever starting a terminal.

**One permission gate.** Every tool call passes through `permitted()` in
`src/core/tools/registry.ts`; there is no second route to the filesystem or the
shell. A session approval is remembered only when the decision comes back
`suppressible`, which is what stops a guardrail from being remembered by
mistake — a refusal you were meant to see cannot be turned off by an earlier
"yes".

**Resume in place.** Each run writes a `session.jsonl`, one record per line,
holding both the messages the model saw and the view the terminal drew. `/resume`
reopens a session in the folder it already owns instead of copying its history
into a new one, so a resumed run and its original stay a single session on disk.

## Docs

- [Install](https://coding-cli-docs.vercel.app/start/install/)
- [Your first run](https://coding-cli-docs.vercel.app/start/first-run/)
- [Commands](https://coding-cli-docs.vercel.app/reference/commands/)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
