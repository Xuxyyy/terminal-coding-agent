---
title: Evaluation
description: Permission safety, package and CLI release checks, and the preserved historical baseline.
sidebar:
  order: 3
---

`acc` keeps permission safety separate from installed-product behavior. The
embedded Task/Case Evaluation has been removed. Its dated results remain in
the historical baseline.

## Active checks

### Free repository tests

`npm test` typechecks and runs the product and evaluator tests. No API key,
network request, or paid call is used.

### Permission-judge evaluation

`npm run eval:judge` runs 60 hand-labeled permission decisions against a real
model. False-allows, false-refusals, and provider or timeout errors remain
separate. The active release standard allows no false-allows.

This is a paid live-model check and requires explicit approval.

### Package and CLI behavior

`npm run eval:operational` builds and packs the repository, installs the
archive into a temporary prefix, and invokes its generated `acc` binary. It
checks archive contents, installed binary startup, invalid print flags,
non-TTY startup, missing-key behavior, and unsafe home/root workspaces.

Independent paid release checks additionally drive the packed CLI in print
mode and exercise TUI resume in a real terminal. They are never part of CI and
require explicit approval.

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

The standards checker prints judge metadata, judge harness health,
false-allows, operational metadata, and operational results on separate lines.
There is no combined score.

## Historical baseline

The preserved baseline was recorded on **2026-09-17**. It requested
`deepseek-v4-flash`, which DeepSeek documented as routing to
**DeepSeek-V4.1-Flash** on that date.

| Historical axis | Result |
| --- | ---: |
| Offline repository tests | 1,022/1,022 |
| Permission-judge outcomes | 180/180 scored, 0 errors |
| Permission false-allows | 0/105 |
| Permission false-refusals | 1/75 |
| Task trials solved | 75/75 |
| Task trials clean | 75/75 |
| Smoke reliability (`pass^3`) | 10/10 |
| Focused reliability (`pass^3`) | 12/12 |
| Workflow reliability (`pass^3`) | 3/3 |
| Operational scenarios | 6/6 |
| Independent packed CLI/TUI scenarios | 2/2 |

The Task/Case rows are historical only. The embedded runner, fixtures, and
composition tool no longer ship in this repository.

The complete machine-readable record remains at
[`evals/baselines/2026-09-17-deepseek-v4-flash.json`](https://github.com/Xuxyyy/terminal-coding-agent/blob/main/evals/baselines/2026-09-17-deepseek-v4-flash.json).
It preserves the task composition, source-result names, per-case results,
token usage, and dated cost range. The active Judge and operational thresholds
are in
[`evals/baselines/standards.json`](https://github.com/Xuxyyy/terminal-coding-agent/blob/main/evals/baselines/standards.json).

The historical task evidence was a disclosed composition, not one continuous
run. Four corrected case contracts were rerun for three repeats, while the
other 21 cases were retained. It used 1,089,728 tokens and reported a dated
task-only cost range of **$0.06–$0.21**.

The historical independent installed-product gate also passed two approved
live scenarios: a packed print-mode edit and a real-terminal TUI resume. It
used 12,512 observable tokens and reported a dated cost range of about
$0.00037–$0.00213. All temporary resources were removed.

The baseline describes one model route, date, and environment. It does not
guarantee future provider behavior. Live judge and independent release checks
cost money and require explicit approval.

The detailed commands and evidence boundaries live in
[`docs/evals.md`](https://github.com/Xuxyyy/terminal-coding-agent/blob/main/docs/evals.md).
