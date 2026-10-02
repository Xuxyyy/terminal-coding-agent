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

## Credentials during third-party evaluations

Local ACC runs still use the provider key in their process environment. Shell
commands in a local run inherit that environment; the permission gate does not
isolate credentials from approved scripts.

Evaluation adapters can instead set `ACC_MODEL_RELAY_URL` and `ACC_MODEL` in a
task container, without a provider key. ACC uses the host relay for model calls
and skips loading `.env` files in this mode. The host holds the key and accepts
only bounded, stateless model requests through a temporary capability. This
mode requires a compatible, rebuilt ACC runtime and deliberately has no
direct-key fallback when the relay fails.

The task container must also exclude host credential files, host process
namespaces, and the Docker socket. Environment filtering alone cannot protect
credentials that untrusted code can read elsewhere. A task can use its relay
capability within the trial limits, so this protects the provider credential,
while allowing the model use needed for the evaluation.

## What is worth reporting

Anything that gets past that gate:

- a path that escapes the workspace root, including through a symlink;
- a `bash` string the classifier reads as safe when it is not, or a wrapper that
  hides its worst stage;
- an approval remembered when the decision was not `suppressible`;

## What is not

- The agent running a command you approved. The gate asked; you said yes.
- `npm test` running whatever `package.json` says. It is auto-allowed in
  `auto-edits`, and the script can do anything. This is known, documented in
  `docs/permissions.md`, and answered with an `ask` rule in `settings.json`.
