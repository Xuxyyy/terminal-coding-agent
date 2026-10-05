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

Sandbox defaults to Off. Use `/sandbox` while idle or `--sandbox on|off` at launch.
The choice lasts for the current ACC process. Permission modes and rules still govern
action approval in both modes.

With On, Bash, ripgrep, and file workers have restricted file access and no network
by default. Extra paths or network require one-call approval. Known credential
storage stays hidden, and a failed backend never falls back to Off.

Both modes use clean child environments and private HOME/temp files. Off removes
ACC's OS file and network restrictions. Environment cleanup cannot stop commands
from reading credential files and is not complete credential protection.
`docs/sandbox.md` describes platform requirements and limits.
`docs/permissions.md` describes action authorization.

## Credentials during third-party evaluations

Local ACC's trusted model client still uses the provider key. Tool workers in both
modes receive an allowlisted environment without that key or relay access. With
On, they also cannot read known credential storage. Keys copied into otherwise-readable
source files are outside this protection; do not put credentials there.

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

Anything that gets past the permission or sandbox boundaries:

- a path that escapes the workspace root, including through a symlink;
- a `bash` string the classifier reads as safe when it is not, or a wrapper that
  hides its worst stage;
- an approval remembered when the decision was not `suppressible`;
- with Sandbox On, a command or file tool reading known credential storage, or reaching ungranted
  outside files, network connections, host processes, or host Unix sockets;
- a failure with Sandbox On followed by unsandboxed execution;

## What is not

- The agent running a command you approved. The gate asked; you said yes.
- `npm test` running the project's script within its selected sandbox mode. It is
  auto-allowed in `auto-edits`; scripts can still change permitted project files.
  An `ask` rule may require action approval independently of the sandbox mode.
