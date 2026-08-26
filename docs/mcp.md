# MCP

Status: built.
Covers: `src/core/mcp/` — reaching an MCP server over stdio and turning what it
offers into tools; the `mcpServers` block in `src/core/settings.ts`; the
`{kind: 'mcp'}` branch of the gate; `/mcp`
Read when: changing how servers connect, adding a transport, or changing what an
MCP call asks
See also: `tools.md` (the `Tool` shape an adapted tool has to satisfy),
`permissions.md` (the gate every call passes), `features.md` (what ships today)

Key names, so a search finds this file: `parseServers`, `connectServers`,
`connectOne`, `connectedTools`, `serverStatus`, `adaptTool`, `toolName`,
`MCP_REASON`, `mcpReadout`.

## What this is

MCP — the Model Context Protocol — is an open spec with two halves. A **server**
offers tools over a transport; a **client** connects to one and uses what it
offers. `acc` implements the **client** half, and only that. It is the same
category as Claude Code or Cursor: a thing that consumes servers. It does not
serve its own five tools to anyone, and nothing here is a step toward that.

What follows are client-side decisions only. What a server's tools are called,
what they do, and whether they are any good is the server's problem. `acc` has
three jobs — reach one, publish what it found, and never let it act unasked.

## The path a tool takes

Four files, in order, from a line of JSON to a tool the model can call.

| Step | Where | What happens |
|---|---|---|
| parse | `src/core/settings.ts:113-200` | `parseServer`/`parseServers` turn the `mcpServers` block into `{command, args, env}` per server |
| connect | `src/core/mcp/connect.ts:52-96` | `connectOne` spawns the command over `StdioClientTransport` and calls `listTools()` |
| adapt | `src/core/mcp/adapt.ts:30-47` | `adaptTool` reshapes each listed tool into the `Tool` shape `tools.md` describes |
| publish | `src/core/tools/index.ts:13` | the adapted tools are appended to the built-in five, and the model is offered one flat list |

Every published name is `mcp__<label>__<tool>` (`adapt.ts:18-20`), where `label`
is the key you wrote in `mcpServers`. **That scheme is what stops two servers
colliding.** Two servers that both offer `search` arrive as `mcp__github__search`
and `mcp__linear__search`, and because the left half is a name you chose, a
collision is one you can fix by renaming a key in your own settings file.

The important property of the table is its last row. Nothing downstream knows a
tool is remote: `runTool` calls `run`, `permitted()` reads `request`, and the UI
draws a row, all against the same `Tool` interface a built-in satisfies. An
adapted tool differs in exactly two ways — its `schema` is `z.record(z.unknown())`
because the real shape is the server's JSON Schema passed straight through as
`parameters` (`adapt.ts:38-39`), and its `request` is `{kind: 'mcp'}`
(`adapt.ts:40`). `run` awaits the remote call, flattens the text blocks, and
throws the text when the server sets `isError` (`adapt.ts:41-46`), so a remote
failure reaches the loop as a tool error like any other.

## Why stdio first

stdio is one transport of several in the spec, and it is the only one built.
`connect.ts:57-62` constructs a `StdioClientTransport` and nothing else.

Two reasons. It covers most of the ecosystem as it actually exists — the servers
people publish are npm or Python packages meant to be spawned. And it needs no
OAuth, no browser round trip, and no token storage, so the whole authentication
question stays out of a first slice.

The part worth writing down is the shape of what a second transport would cost.
**`connect.ts:57-62` is the only transport-specific code in the module.**
Everything after it works against the SDK's `Client`, and `adapt.ts` would not
change by a single line. Swapping in an HTTP transport is a constructor and a
config shape.

So the cost of hosted servers is not MCP. It is OAuth: a browser flow, a token
store, refresh, and revocation, none of which this repo has anywhere else. That
is the actual reason it is unbuilt, and it should be named as that rather than as
a protocol limitation.

## Why an MCP call is never automatic

No MCP call is ever allowed outright, in any mode. `decide.ts:78-80` is the whole
rule:

```ts
if (request.kind === 'mcp') {
  return outcomeFor({level: null, reason: ''}, mode, MCP_REASON);
}
```

`level: null` is what makes that unconditional. `withinCut` returns false for a
null level in every mode (`mode.ts:25-27`), so the `allow` branch of `outcomeFor`
is unreachable and the outcome is whatever `aboveCut(mode)` gives: **`ask` in
`ask-edits` and `auto-edits`, `judge` in `auto`** — the same route any
unclassified action takes. The reason carried to the prompt is `MCP_REASON` at
`decide.ts:28` — *an MCP server outside the workspace runs this*.

**That branch returns before the classifier, and the bypass is deliberate.** The
classifier reasons about two things: shell command text and file paths. An MCP
call is neither. All it has is a name the server chose and an argument object
against a schema the server also wrote. Classifying it would mean inventing a
verdict out of a string a third party controls — `delete_everything` would read
as dangerous and `helper` as safe, with nothing behind either reading. Better to
hold no opinion and say so than to hold a fabricated one.

The judge is a different question, which is why `auto` still sends the call
there. The judge does not ask whether an action is dangerous; it asks whether the
user already authorized it (`JUDGE_RUBRIC`, `judge.ts:5-38`), and it answers from
the user's own messages. That is a question a server-chosen name cannot poison,
so it survives here where the classifier does not. The call is rendered to it as
`call the MCP tool: <server>/<tool>` (`judge.ts:98-99`), and a `REFUSE` — or no
judge configured at all — falls through to the prompt (`registry.ts:96-101`).

The prompt is `suppressible: true`, so the answer is remembered for the session.
`approvalKey` at `decide.ts:119` returns `mcp <server> <tool>`, which sets the
grain: approval is remembered **per tool, not per server and not per argument**.
Approving `mcp__github__list_issues` once makes every later call to that tool
quiet; it says nothing about `mcp__github__create_issue`, which asks on its own
the first time. A server cannot earn blanket trust by being approved once for its
most harmless tool.

## Why user settings only

`mcpServers` is read from `~/.acc/settings.json` and refused anywhere else.
`settings.ts:180-185` throws when a project file carries the key, and the error
names the user file so the fix is obvious.

The reason is worth more than the rule: **a repository you cloned must not be
able to spawn a process on your machine.** A project-level `mcpServers` block
would mean that `git clone` followed by `acc` runs whatever command a stranger
wrote in a JSON file, before the model has said anything and before the
permission gate has seen a call — the server is spawned at boot, so no prompt
would ever stand between the clone and the process.

This is the same rule `model` follows (`settings.ts:88-93`), and for a related
reason: settings that a checkout can set are settings an attacker can set. Rules
stay per-project because a rule can only ever narrow what is allowed.

## Secrets stay in the environment

`${VAR}` expands in `args` entries and in `env` values, and nowhere else
(`settings.ts:99-112`, called at `settings.ts:153` and `settings.ts:168`). The
`command` is taken literally. That keeps the token out of the settings file,
which is a plain-text file people paste into issues.

An unset variable is a **startup error naming the variable**, not a silent empty
string (`settings.ts:110-113`). The failure mode this avoids is the bad one: a
server that connects, lists its tools, and then fails every call with an opaque
401 that looks like the server's fault. Refusing to start says which variable is
missing, once, before anything else happens.

`command` is excluded on purpose. Expanding a variable into the executable name
would make the binary that gets spawned depend on the environment — a different
class of thing from a flag or a token.

## One bad server does not take the others down

`connectOne` catches everything (`connect.ts:88-95`). A server that fails to
spawn, fails to speak MCP, or does not answer within `CONNECT_TIMEOUT` becomes a
`failed` status with a reason and an empty tool list. The others keep theirs, and
the CLI starts. `connectServers` runs them all through `Promise.all`
(`connect.ts:103-107`), so one slow server costs the boot its own timeout, not
the sum of them.

`CONNECT_TIMEOUT` is 15s (`connect.ts:10`) because a server spawned through `npx`
may download a package on first run. `connectServers` takes it as an argument so
tests can pass 400ms instead of waiting.

`reason()` at `connect.ts:27-30` exists because a spawn failure can carry an
empty message; the readout falls back to *the server could not be started*
rather than printing a blank line after the dash.

**A failure is visible or it did not happen.** `/mcp` is the readout —
`mcpReadout` at `src/ui/mcp.ts:19-27`, drawn from `serverStatus()`:

```
github — ready, 12 tools
linear — failed: spawn linear-mcp ENOENT
```

With nothing configured it names the user settings file instead of printing
nothing. `oneLine` flattens the reason because a multi-line spawn error would
break the alignment of a status list.

Boot does not block on any of this, and nothing reconnects. A server that was
dead at startup stays dead until the CLI is restarted.

## How it is tested

`src/tests/fixtures/echo-server.js` is a **real MCP server**, and the tests spawn
it. It is not a mock of the SDK and not a stub transport: the test process starts
a second process, speaks MCP to it over stdin and stdout, and asserts on what
comes back (`src/tests/core/mcp-connect.test.ts:84`).

That is the strongest fact in the module. It means the round trip — spawn,
handshake, `listTools`, `callTool`, the content blocks coming back — is exercised
against the real SDK on both ends, so a version bump that changes the wire
behaviour fails here rather than in someone's terminal.

The failure paths are covered the same way, with real processes: a command that
does not exist (`mcp-connect.test.ts:99`), one server failing while another keeps
its tools (`mcp-connect.test.ts:110`), and a server slower than the timeout
(`mcp-connect.test.ts:133`).

## Not built, on purpose

Each of these is absent for a reason, and the reason is not "not got to it yet".

- **Hosted/HTTP transport and OAuth.** The transport is a constructor swap
  (`connect.ts:57-62`); the authentication is a browser flow, a token store,
  refresh, and revocation that this repo has nowhere else. The cost is OAuth, and
  it is worth its own slice rather than a corner of this one.
- **Resources and prompts.** MCP servers can offer more than tools. Tools are the
  half that reaches the model through machinery that already exists — a resource
  would need a place in the context window and a story about who chooses it,
  which is a context-management design, not a protocol one.
- **`mcp(...)` rules in `permissions`.** There is no way to write
  `allow: ["mcp(github:*)"]`. Session approval already makes a repeated tool
  quiet, and a rule that persists across sessions grants a third-party process
  standing trust from a file — the thing this module's other decisions are all
  built to avoid. It wants a considered design, not a pattern match.
- **Per-project servers.** Deliberate, and covered above: a cloned repository must
  not be able to spawn a process.
- **Reconnect without a restart.** Servers connect once at boot. A server that
  dies mid-session stays dead and its tools keep failing until `acc` restarts.
  This is the weakest of the five — it is a real gap rather than a stance, and it
  needs a supervision policy (when to retry, how often, what the model is told
  meanwhile) before it needs code.
