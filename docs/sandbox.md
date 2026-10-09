# Sandbox MVP

ACC defaults to **Sandbox: Off**. Permission checks remain active in both modes.
Bash, ripgrep, file-operation workers, and backup snapshots all use the selected mode.
The model client and private session storage remain outside tool execution.
Sandbox On is supported only on macOS. Linux uses Sandbox Off.

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

Linux and other platforms do not have an ACC sandbox backend. Operations in On mode
return a clear unsupported-platform error before starting the command. If macOS's
backend is missing or cannot initialize, operations also fail. They never fall back
to Off automatically. A container needs its own restrictions too: do not
expose host credentials, the host PID namespace, or a Docker socket.

## Limits and verification

When On, the sandbox protects access to known storage, not secrets copied into arbitrary
otherwise-readable source files or configuration. Writable project files can
still be damaged. The sandbox is not a general secret detector or a snapshot of
concurrent host changes.

When On, all children inherit the OS access policy. Timeout, cancellation, and normal
completion kill the ordinary process group; deliberately detached daemons on
macOS need stronger lifecycle containment before daemon workflows are supported.
Memory/CPU/disk quotas and domain rules are deferred. Output capture has a 32 MiB
ceiling in addition to each tool's display limit.

`src/tests/core/sandbox.test.ts` tests real enforcement using fake keys, normal
builds, symlinks, hard links, directory renames, one-call grants, local HTTP and
Unix sockets, cancellation, and binary backups. It makes no paid model calls.
