---
title: Install
description: Clone the repository, build it with npm install, and link the acc command onto your PATH.
sidebar:
  order: 1
---

`acc` is installed from source: clone it, build it, link it. It is not on the
npm registry yet, so there is no `npm install -g acc`.

## Before you start

- **Node 22 or newer.** Check with `node -v`. Anything older is refused by the
  package itself.
- **ripgrep (`rg`) on your `PATH`.** The `grep` tool shells out to it. Without
  it, `grep` does not crash — it returns `ripgrep (rg) is not on PATH, so grep
  cannot run. Use bash with grep -rn instead.`, and the agent searches with the
  shell instead. That works, but it is slower and it ignores your `.gitignore`.
  Install ripgrep with `brew install ripgrep`, `apt install ripgrep`, or from
  [the ripgrep releases](https://github.com/BurntSushi/ripgrep/releases).
- **An API key** for DeepSeek, GLM, or Kimi. One is enough.

## Install

```bash
git clone https://github.com/Xuxyyy/coding-cli.git
cd coding-cli
npm install
npm link
```

There is no separate build step. `npm install` runs the package's `prepare`
script, which is `tsc`, so the TypeScript is compiled into `dist/` as part of
installing. `npm link` then puts the `acc` command on your `PATH`, pointing at
that build.

## Check it worked

```bash
which acc
```

That should print a path ending in `bin/acc`. Run `acc` inside a project folder
and you should get the welcome header.

`acc` takes **no command-line arguments and no flags** — not even `--help`.
Anything you pass it is an error, because the folder you are standing in is the
only input it needs. If you try `acc --help`, you will get
`error: unknown option: --help`, which means the install is fine.

## Keeping it up to date

The link points at your clone, so updating is a pull and a rebuild:

```bash
cd coding-cli
git pull
npm install
```

## Uninstall

```bash
npm unlink -g coding-cli
```

That removes the global link. Delete the clone afterwards if you want it gone,
and remove `~/.acc/` to drop your saved sessions and settings with it.

## Why not `npm install -g`

The package is marked private and is not published, so there is nothing on the
registry to install. Cloning is the only supported route today. If publishing
happens later, it will be one extra section on this page and nothing else on
this site will change.
