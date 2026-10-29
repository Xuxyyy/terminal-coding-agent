# Documentation

Start with the [installation instructions](../README.md#quick-start).

- [Configuration](configuration.md): settings files, models, API keys, and named subagents.
- [Commands](commands.md): interactive commands, keyboard controls, and recovery limits.
- [Features](features.md): current capabilities and known limits.
- [Agent loop and architecture](agent-loop.md): the core/UI boundary, streaming, and context management.
- [Tools](tools.md): tool inputs, limits, background commands, and subagents.
- [Permissions](permissions.md): modes, rules, and the permission judge.
- [Sandbox](sandbox.md): controls, access grants, platforms, and limits.
- [Sessions](sessions.md): storage, resume, rewind, and persistent subagents.
- [Print mode](headless.md): noninteractive tasks and structured output.
- [Evaluation](evals.md): offline tests, permission-judge evaluation, and package/CLI checks.

## Updating and uninstalling

To update a linked installation, run `git pull` and `npm install` in your clone.
To remove the global command, run `npm unlink -g terminal-coding-agent`.
Deleting the clone removes its source; deleting `~/.acc/` also removes saved
sessions and settings. If you set `ACC_HOME`, that directory holds those files.
