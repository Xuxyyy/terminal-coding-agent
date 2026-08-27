# Security

## Reporting a problem

Report it privately through
[GitHub's security advisories](https://github.com/Xuxyyy/terminal-coding-agent/security/advisories/new),
not as a public issue.

`acc` is installed by cloning, so there are no released versions to support: the
latest commit on `main` is the only one that gets a fix.

## What `acc` does on purpose

`acc` reads and edits files, and runs shell commands, in the directory you start
it in. That is what the tool is for, and it is not a vulnerability.

**There is no sandbox.** The boundary is the permission gate — `permitted()` in
`src/core/tools/registry.ts`, which every tool call passes through, with path
confinement inside each tool as a second layer. Anything reaching outside the
workspace asks every time and can never be remembered for the session, and no
`allow` rule can silence an escape such as `sudo`, `git push`, or `dd of=`.
`docs/permissions.md` has the full model and the reasoning.

## What is worth reporting

Anything that gets past that gate:

- a path that escapes the workspace root, including through a symlink;
- a `bash` string the classifier reads as safe when it is not, or a wrapper that
  hides its worst stage;
- an approval remembered when the decision was not `suppressible`;
- an MCP server or tool that reaches a tool call without being judged.

## What is not

- The agent running a command you approved. The gate asked; you said yes.
- `npm test` running whatever `package.json` says. It is auto-allowed in
  `auto-edits`, and the script can do anything. This is known, documented in
  `docs/permissions.md`, and answered with an `ask` rule in `settings.json`.
