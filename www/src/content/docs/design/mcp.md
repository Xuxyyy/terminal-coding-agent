---
title: Connecting to MCP servers
description: Why acc is an MCP client and not a server, why stdio came before hosted transports, why no permission mode ever runs a server's tool silently, and what is deliberately missing.
sidebar:
  order: 4
---

`acc` ships with five tools. An MCP server is how you give it more without
touching its code — you name a command in your settings file, `acc` starts it,
and whatever tools it offers are on the model's list for the rest of the
session. This page is about the decisions that shape it, not the syntax; the syntax
is on [Settings](/reference/settings).

## A client, not a server

The Model Context Protocol has two halves. A **server** offers tools; a
**client** connects to one and uses them. `acc` is the client half only, which
puts it in the same category as Claude Code or Cursor. It does not expose its
own five tools to anything else, and nothing here is a step toward that.

The distinction is worth stating because "supports MCP" is ambiguous and the
ambiguity always resolves the same way in practice. Being the client is the half
that makes a coding agent useful; being the server is a different product.

What follows from it is a posture: every server is somebody else's code, running
in its own process, with tools whose names and descriptions that author wrote.
Everything below is a consequence of taking that seriously.

## stdio before hosted

An MCP server can be reached over a pipe to a local process, or over HTTP to a
service somewhere. Only the first is built.

The first reason is coverage. The servers people actually publish are npm or
Python packages meant to be spawned; stdio reaches most of the ecosystem as it
exists rather than as the spec allows.

The second is the one I would want to read about someone else's project.
Constructing the transport is the **only** transport-specific code in the
module. Everything after it works against the protocol client, and the part that
turns a remote tool into one the model can call would not change by a single
line if HTTP arrived tomorrow.

So the honest statement of the cost is: hosted servers are not blocked on MCP,
they are blocked on OAuth. A browser round trip, a token store, refresh,
revocation — none of which this project has anywhere else, and all of which is
security-shaped code that is bad to write in a hurry. Naming that as the price
seemed better than implying the protocol was the hard part.

## No mode runs a server's tool silently

`acc` has three permission modes, and the most permissive one exists so that a
real task can run start to finish without interrupting you. An MCP tool is
exempt from all of it. There is no mode, and no rule you can write, that makes a
server's tool run without a decision.

The interesting part is *why the gate does not simply judge them like everything
else*. `acc` classifies what an action does before deciding — it reads a shell
command, or the path a write is aimed at, and works out whether git could undo
it. That machinery has nothing to bite on here. An MCP call is not a command and
not a path. It is a name the server chose and an argument object against a
schema the server also wrote.

Classifying it would mean deriving a verdict from a string a third party
controls. `delete_everything` would read as dangerous and `helper` as safe, and
neither reading would mean anything — a hostile server picks the safe-sounding
name for free. **The gate declines to have an opinion, and says so in the
prompt.** That felt more defensible than a confident guess, and much more
defensible than a list of tool names known to be fine.

Saying yes is still remembered, but per **tool**, not per server. Approving a
server's read-only tool once tells `acc` nothing about the one that writes; that
one asks on its own the first time it is used. A server cannot earn standing
trust by being harmless once.

## Your settings, not the repository's

Most of what `acc` reads can be set per project, because a project's settings
can only ever make it stricter. Servers are the exception: the `mcpServers`
block is read from your own settings file, and finding it in a project's file is
a startup error that says so.

The reason is short. A project-level server list means that cloning a repository
and running `acc` in it starts whatever process a stranger wrote — before the
model has said a word, and before the permission gate has seen anything to gate,
because servers start at boot. No amount of prompting later fixes a process that
is already running. The only safe answer is that the machine's owner is the one
who decides what runs on it.

The same rule covers tokens. A server's environment is written as `${VAR}`, so
what lives in the settings file is the name of a variable and not a secret; if
the variable is unset, `acc` refuses to start and names it, rather than handing
a server an empty string and letting every call fail with a puzzling error.

## One dead server is not a dead session

Servers are started in parallel at boot, and each one is allowed to fail on its
own. A server that is not installed, does not speak the protocol, or never
answers is recorded as failed with the reason, contributes no tools, and is
otherwise ignored. The others keep theirs and `acc` starts normally.

This is worth a design decision rather than a `try`/`catch` because the
alternative is common and bad: a stale entry in a config file that stops the
whole tool from launching, days after you added it, with an error about a
package you have forgotten. Startup is where a small tool earns trust.

The corollary is that a failure has to be **visible**, or the tools simply seem
to be missing. `/mcp` is that readout — every server, ready with a tool count or
failed with the reason, and a pointer to the settings file when there are none
at all.

## What is not built, and what each is waiting for

- **Hosted transport and OAuth.** The transport is a swap; the authentication is
  a project. It is waiting for a slice of its own, not for a decision.
- **Resources and prompts.** Servers can offer more than tools. Tools are the
  half that arrives through machinery that already exists. A resource would need
  an answer to who decides it goes in the context window and what it displaces —
  that is a context-management design, not a protocol one.
- **Rules for MCP tools.** You cannot write a rule in your settings file that
  pre-approves a server's tools across sessions. Session approval is deliberately
  the only memory an MCP call has: a rule that persists is standing trust granted
  from a file, which is the thing every other decision on this page is arranged
  to avoid. It wants a considered design.
- **Per-project servers.** Refused on purpose, as above. This one is not waiting
  for anything.
- **Reconnect without a restart.** Servers connect once. A server that dies
  mid-session stays dead until you restart. This is the weakest of the five —
  a genuine gap rather than a position — and it is waiting on a policy for when
  to retry and what the model should be told meanwhile, which is more of the work
  than the reconnecting is.

## Full reasoning

- [`docs/mcp.md`](https://github.com/Xuxyyy/coding-cli/blob/main/docs/mcp.md)
  — the path from a line of JSON to a tool the model can call, the permission
  branch line by line, and how the round trip is tested against a real server.
