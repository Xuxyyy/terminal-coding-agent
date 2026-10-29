# Interactive commands

Type `/` while ACC is idle to open the command menu. Keep typing to filter it,
use the arrow keys to select a command, and press Enter to run it.

| Command | What it does |
| --- | --- |
| `/context` | Shows context usage and estimated system, tool, message, and free-space totals. |
| `/compact` | Keeps recent user prompts and summarizes older context. A failed summary leaves history intact. |
| `/clear` | Clears the conversation and closes its session; your next message starts a new session. |
| `/resume` | Lists saved conversations for this workspace and reopens one in place. Sessions active elsewhere cannot be reopened. |
| `/rewind` | Returns to before a chosen user message and restores available file-tool backups after confirmation. |
| `/permission` | Switches permission mode and saves it in your user settings for later runs. |
| `/sandbox` | Switches sandbox protection. Sandbox On is supported only on macOS. |
| `/model` | Opens the model picker; `deepseek-flash` is the coding choice. |

`/rewind` restores changes recorded by `edit_file` and `write_file`. It cannot
undo shell changes, changes you made yourself, or separate child conversations.
See [sessions](sessions.md) for recovery details and [permissions](permissions.md)
for what a mode allows. Sandbox controls and access grants are described in
[sandbox](sandbox.md).

Context compacts automatically at 80% projected usage by default. `/context`
uses the last measured total when available; its parts are estimates.
See [context management](agent-loop.md#context-pressure) for the thresholds and
[configuration](configuration.md) for overrides.

## Keys and leaving

| Input | What it does |
| --- | --- |
| Esc while working or in an approval box | Stops the turn and its active work. |
| `n` in an approval box | Refuses that action; the agent can continue the task. |
| Up / Down in the input box | Walks saved prompt history; inside the slash menu, moves through commands. |
| `exit`, `quit`, or `q` | Closes ACC when typed as a plain word. |

Approvals may offer `y` for one call and `a` for the session. Some actions only
allow one-call approval. Interactive conversations are saved as they run;
[print mode](headless.md) does not save resumable sessions.
