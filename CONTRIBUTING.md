# Contributing to `acc`

This file covers the few things you cannot get from the code or the
[docs site](https://coding-cli-docs.vercel.app).

## Setup

Node 22 or newer, then `npm install`. `prepare` runs `tsc`, so the install
builds the project — there is no separate build step.

## The one check

`npm test` is the whole check. It runs `tsc` first, so a type error fails the
tests, then `node --test` over the compiled `dist/`. Re-run a single file for
full output with `node --test dist/tests/<path>.test.js`.

The site is separate: verify anything under `www/` with
`npm run build --prefix www`. `npm test` does not touch it.

## Never run `acc` inside this repo

The workspace is the current directory, so `acc` launched here would edit its
own source. Point it at a throwaway folder.

## The seam

`src/core` runs the agent and never imports React; `src/ui` draws it with Ink.
They meet at one interface, `Host` in `src/core/host.ts`. No import points the
other way.

## Commits

One Conventional Commits subject line — `type(scope): lowercase imperative
summary` — and no body. If a change is too big for one line, split it.

## Reading further

`docs/` has one design doc per subsystem, each saying what it covers and when to
read it. `CLAUDE.md` carries the same rules in the form the agent reads them.
