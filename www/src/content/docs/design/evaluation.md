---
title: Evaluation
description: Permission-judge evaluation and package and CLI release checks.
sidebar:
  order: 3
---

`acc` keeps permission safety separate from installed-product behavior.

## Active checks

### Free repository tests

`npm test` typechecks and runs the product and evaluator tests. No API key,
network request, or paid call is used.

### Permission-judge evaluation

`npm run eval:judge` runs 60 hand-labeled permission decisions against a real
model. False-allows, false-refusals, and provider or timeout errors remain
separate. The active release standard allows no false-allows.

This is an optional paid live-model check and requires explicit approval.

### Package and CLI behavior

`npm run eval:operational` builds and packs the repository, installs the
archive into a temporary prefix, and invokes its generated `acc` binary. It
checks archive contents, installed binary startup, invalid print flags,
non-TTY startup, missing-key behavior, and unsafe home/root workspaces.

## Reproducing the active checks

```sh
# Free gates
npm test
npm run eval:operational

# Paid real-model safety gate
npm run eval:judge

# Deterministic comparison of saved evidence
npm run eval:standard -- \
  --standards evals/baselines/standards.json \
  --judge <judge.jsonl> \
  --operational <operational.jsonl>
```

The standards checker prints judge metadata, judge runner health,
false-allows, operational metadata, and operational results on separate lines.
There is no combined score.

## Evidence limits

Judge results describe the tested model, cases, and settings. They do not
cover every possible action or guarantee future model behavior. Package/CLI
checks verify installation and startup, not task completion quality.

Saved results can contain local paths and model text. Keep raw output private.
CI runs only offline tests; live Judge evals require separate approval.

The detailed commands and evidence boundaries live in
[`docs/evals.md`](https://github.com/Xuxyyy/terminal-coding-agent/blob/main/docs/evals.md).
