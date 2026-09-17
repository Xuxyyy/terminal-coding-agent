---
title: Evaluation
description: Four independent evidence layers for correctness, focused coding capability, complete workflows, and the installed CLI.
sidebar:
  order: 3
---

`acc` uses four evidence layers because one score cannot tell whether a failure
came from code, a model capability, a safety decision, or packaging.

## Baseline scorecard

The current baseline was recorded on **2026-09-17**. It requested
`deepseek-v4-flash`, which DeepSeek documented as routing to
**DeepSeek-V4.1-Flash** on that date.

| Axis | Result |
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

These numbers stay separate. There is no overall accuracy figure that could
let coding success hide a safety regression.

The machine-readable sanitized baseline is
[`evals/baselines/2026-09-17-deepseek-v4-flash.json`](https://github.com/Xuxyyy/terminal-coding-agent/blob/main/evals/baselines/2026-09-17-deepseek-v4-flash.json).
The release thresholds and exact case IDs are in
[`evals/baselines/standards.json`](https://github.com/Xuxyyy/terminal-coding-agent/blob/main/evals/baselines/standards.json).

## The four layers

### 1. Free offline correctness

`npm test` typechecks and runs every unit, fixture, grader, scoring, standards,
and operational-runner test. Reference solutions must pass. Plausible negative
controls must fail. No API key or network request is used.

### 2. Focused capabilities

Twelve small cases each isolate one main question: can the agent diagnose a
non-local failure, preserve user work, obey repository instructions, repair a
type or build contract, move files safely, recover from a wrong command, or
verify a fix?

The ten original easy cases remain a separate smoke suite. They are saturated
regression checks, not presented as a difficult benchmark.

Browse the tracked
[`evals/cases/task/`](https://github.com/Xuxyyy/terminal-coding-agent/tree/main/evals/cases/task)
fixtures to see every prompt, starting workspace, allowed write, reference
solution, negative control, and deterministic check.

### 3. Complete workflows

Three larger cases connect the focused abilities:

- repair a user-visible bug and add its regression test;
- implement and register a small public feature with tests;
- refactor across modules while preserving the public API and behavior.

Focused evidence identifies narrow capability regressions. Workflow evidence
shows that the inspect → diagnose → edit → verify loop works as a whole. They
are reported separately so a workflow pass cannot conceal a focused weakness.

### 4. Installed-product behavior

The free operational runner builds and packs the repository, installs the
archive into a temporary prefix, invokes its generated `acc` binary, checks
flag and non-TTY failures, verifies missing-key behavior, and confirms that
unsafe home/root workspaces are refused before model use.

Independent paid release checks additionally drive the packed CLI in print
mode and the interactive UI in a real terminal. They are never part of CI and
require explicit approval.

## Solved and clean are different

Every task trial reports two axes:

- **solved** means every case check passed;
- **clean** means no file outside the declared write set changed and the
  harness did not error.

An agent could make a test command pass by editing the wrong file or deleting a
test. That outcome may be solved, but it is not clean. The release standard
rejects any unclean trial rather than averaging it with successful work.

`pass^3` is also strict: all three repeats for a case must pass. It is not
best-of-three.

## Reproducing the checks

```sh
# Free gates
npm test
npm run eval:operational

# Paid real-model suites — run only with deliberate approval
npm run eval:task:smoke
npm run eval:task:focused
npm run eval:task:workflow
npm run eval:judge

# Deterministic comparison of saved evidence
npm run eval:standard -- \
  --standards evals/baselines/standards.json \
  --judge <judge.jsonl> \
  --task <task.jsonl> \
  --operational <operational.jsonl>
```

The checker prints judge safety, harness health, cleanliness, smoke,
capability suites, capability categories, and operations on separate lines.

## Evidence notes and limits

The task baseline is a disclosed composition, not one continuous run. The
first complete run exposed four unfair case contracts. After those contracts
passed updated offline reference and negative-control tests, only those four
cases were rerun for three repeats; the other 21 cases were retained. The
composed report records both source result names and all replaced case IDs.

Task evidence used 1,089,728 tokens: 1,000,769 prompt and 88,959 completion.
The product's usage event does not expose cache-hit tokens, so the dated task
cost is reported as a **$0.06–$0.21 range**, not an exact charge. Judge token
usage is not emitted and is not invented.

The independent installed-product gate passed two approved live scenarios. The
packed binary completed a real print-mode edit with valid JSON events and no
stored headless session. A real tmux TUI returned `E2E_TUI_OK` without tools,
exited, resumed the same conversation, and exited again. Observable E2E usage
was 12,512 tokens, with a dated cost range of about $0.00037–$0.00213. Cleanup
removed every temporary package, workspace, isolated home, and tmux session.

This suite measures deterministic repository outcomes. It does not measure
subjective code quality, compare `acc` with other agents, prove general success
outside these cases, or guarantee that a future provider route behaves like
the model served on 2026-09-17.

The detailed methodology, case inventory, local raw-result paths, and evidence
rules live in
[`docs/evals.md`](https://github.com/Xuxyyy/terminal-coding-agent/blob/main/docs/evals.md).
