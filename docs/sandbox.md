# Sandbox MVP

ACC defaults to **Sandbox: Off**. Permission checks remain active in both modes.
Bash, ripgrep, file-operation workers, and backup snapshots all use the selected mode.
The model client and private session storage remain outside tool execution.

## Controls

Use `/sandbox` while idle to choose On or Off. The current state stays visible during
work and permission prompts. To switch during a task, press Esc and wait for it to stop.
The choice lasts for this ACC process, including `/clear`, `/resume`, and rewind.
It is not saved in user settings or restored from a conversation.

Use `acc --sandbox on` to start with isolation, or `acc --sandbox off` to select Off
explicitly. The same flag works with `-p`; a new launch without it starts Off.

## Both modes

Each operation has a clean allowlisted environment, private HOME and temporary files,
Shell startup files disabled, output limits, timeout, cancellation, and ordinary child
process cleanup. Provider keys, relay URLs, agent sockets, and startup injection
variables are not inherited. File tools keep their worker and backup behavior.

**Off removes ACC's OS file-access and network restrictions.** The host or container's
own permissions still apply. Environment cleanup reduces inherited secrets but cannot
stop a command from reading credential files. It is not complete credential protection.
The Bash `access` argument is accepted but ignored when Off; normal action permission
checks still run.

## Access with Sandbox On

- Ordinary workspace files are readable and writable. Selected system toolchains
  and public runtime data are readable. Other host files are unavailable.
- Each call gets a fresh private HOME, temporary directory, and package cache.
  Shell uses `bash --noprofile --norc -c`; personal login/startup files do not load.
- The environment is constructed from an allowlist. Provider keys, the model
  relay URL, SSH-agent sockets, and environment-based code injection are omitted.
- Known credential storage is hidden, including `.acc`, SSH/cloud credentials,
  `.npmrc`, private-key files, and host `.env` files. Sanitized `.env.example`,
  `.env.sample`, and `.env.template` files remain readable. Fake credentials made
  by tests inside the private temporary directory are permitted.
- Existing Git config/hooks and other protected configuration paths are not
  writable without a specific approved write grant. Credential protection cannot
  be overridden by an ordinary access approval.
- Network is off. Host Unix sockets remain blocked even with a network grant;
  private scratch sockets may be used for local IPC.

With On, the file tools perform the actual open/read/write in a sandboxed Node worker.
Backups also obtain their original bytes through the sandbox, before editing.
This prevents a host-side filesystem call from bypassing the boundary after
permission checks, including when a symlink changes.

## One-call grants with Sandbox On

Bash accepts an optional `access` object:

```json
{
  "command": "npm install",
  "description": "Install project dependencies",
  "access": {"network": true}
}
```

`read_paths` grants read access. `write_paths` grants read and write access.
Relative paths are resolved against the workspace, and symlink targets are
resolved before approval. The prompt names the resulting paths and requested
network access. Grants cover that call and its child processes only; they are
never remembered or saved. The user may approve once or deny. A model judge,
allow rule, or remembered command approval cannot supply these grants.

File tools derive a scoped grant from an outside target or protected write
target, so their existing approval covers the specific filesystem access.
Credential requests are refused without a prompt. A deny rule still wins.

A network grant permits broad IP network access, including host loopback services.
The command can upload any data it can read. Domain filtering, authenticated
package/Git brokers, and remembered grants are future work.

ACC never automatically reruns a blocked command. Earlier stages may already
have changed files; sandbox denial does not roll them back.

## Platforms with Sandbox On

macOS uses the installed `/usr/bin/sandbox-exec` and a generated deny-by-default
Seatbelt profile. No additional package is needed. The API is deprecated, so
macOS upgrades need real enforcement checks.

Linux requires Bubblewrap (`bwrap`) and working user/mount/PID namespaces.
The runner starts with a separate filesystem view and PID namespace, drops
capabilities, and isolates the network unless approved. Existing credential
files are masked with unreadable mounts; hidden directories are empty and
unreadable. It does not mount the host root or expose the parent's processes.
Linux write grants require an existing file or directory. For a new outside
file, request its specific existing parent directory explicitly; ACC does not
silently expand a file grant into a directory grant.

If the backend is missing, unsupported, or blocked by a container's namespace
policy, operations in On mode fail. They never fall back to Off automatically. A container needs its own restrictions too: do not
expose host credentials, the host PID namespace, or a Docker socket.

## Harbor

Keep the provider key on the host and keep using the existing host model relay.
Shell does not inherit the task's relay URL; the trusted ACC model client uses it.
The adapter explicitly launches ACC with `--sandbox off`. Use the reusable runtime
artifact with Node, Bash, and ripgrep. Bubblewrap is not needed for Off.

Keep Harbor's normal Docker protections and mounts. Do not add privileged mode,
capabilities, unconfined security settings, host credential mounts, or a Docker socket.
Unpaid install-only and scripted relay/tool checks verify compatibility before any
separately approved paid evaluation. Making Bubblewrap work inside Docker is separate
work and is not required for these checks.

## Limits and verification

When On, the sandbox protects access to known storage, not secrets copied into arbitrary
otherwise-readable source files or configuration. Writable project files can
still be damaged. The Linux file view masks credentials found at launch; it is
not a general secret detector or a snapshot of concurrent host changes.

When On, all children inherit the OS access policy. Timeout, cancellation, and normal
completion kill the ordinary process group; deliberately detached daemons on
macOS need stronger lifecycle containment before daemon workflows are supported.
Memory/CPU/disk quotas and domain rules are deferred. Output capture has a 32 MiB
ceiling in addition to each tool's display limit.

`src/tests/core/sandbox.test.ts` tests real enforcement using fake keys, normal
builds, symlinks, hard links, directory renames, one-call grants, local HTTP and
Unix sockets, cancellation, and binary backups. It makes no paid model calls.

## Verification record — October 5, 2026

- ACC: all 886 tests passed, including both sandbox modes, the TUI controls,
  permission checks, environment cleanup, cancellation, and file backups.
- Harbor adapter: all 19 unit tests passed. Install-only and the unpaid scripted
  smoke test passed with sandbox Off, all five tools, and the real host relay.
  Docker's normal protections remained active, the fake provider key was absent
  from task environment and job files, and the relay closed after the run.
- Real API smoke test: one Gemini 3.8 Flash trial completed in 1m 24s with sandbox
  Off. ACC created and read back `hello.txt`, then finished normally. The adapter
  reported normal Docker protections and no provider key in the task environment
  or job files.
- Harbor recorded reward `0.0` because an Ubuntu package download returned
  `502 Bad Gateway`, preventing the verifier tests from running. ACC/model execution
  passed; Harbor task verification is inconclusive.

Local evidence lives in the sibling Harbor adapter project:
[unpaid smoke trajectory](../../acc-harbor-adapter/jobs/sandbox-off-unpaid-737635e7/hello-world/agent/acc.jsonl),
[paid trial result](../../acc-harbor-adapter/jobs/acc-gemini-3-8-flash-live-20261005/hello-world__74bq6DE/result.json),
and [verifier output](../../acc-harbor-adapter/jobs/acc-gemini-3-8-flash-live-20261005/hello-world__74bq6DE/verifier/test-stdout.txt).
