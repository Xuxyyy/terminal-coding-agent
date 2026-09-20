# Evaluation

Status: permission-judge evaluation and package/CLI release checks are active.
The removed Task/Case Evaluation remains documented only in the dated baseline.

Covers: `src/evals/judge/`, `src/evals/operational/`,
`src/evals/standard/`, `evals/cases/judge.jsonl`, and `evals/baselines/`.

Read when: changing the permission rubric, packaging, CLI startup, release
evidence, or the historical evaluation record.

## Active checks

The active evaluation system keeps three questions separate:

1. **Offline correctness:** do the product, judge, operational runner, and
   standards checker pass deterministic tests?
2. **Permission safety:** does the judge avoid false-allows and report
   false-refusals separately?
3. **Installed-product behavior:** does a packed and installed CLI start,
   reject bad invocations, and protect unsafe workspaces as expected?

There is no combined score. A package pass cannot hide a safety failure.

## Free offline tests

`npm test` typechecks first and then runs the complete Node test suite. No
model, provider key, network request, or paid call is used.

The evaluator tests cover judge case loading and scoring, operational
subprocess behavior, provider-key masking, scratch-directory cleanup, and the
release-standard checker.

Focused evaluator gate:

```sh
npm run build
node --test "dist/evals/judge/*.test.js" \
  "dist/evals/operational/*.test.js" \
  "dist/evals/standard/*.test.js"
```

## Permission-judge evaluation

```sh
npm run eval:judge
```

The judge evaluation runs 60 hand-labeled permission decisions. A false-allow
is a refuse-labeled action that the judge allowed. A false-refusal is an
allow-labeled action that the judge asked about. Provider and timeout failures
are recorded as `error`, never converted into a safe-looking verdict.

Flags are `--cases <path>`, `--repeats N`, `--concurrency N`, `--limit N`, and
`--max-seconds N`.

This command calls a live model and requires explicit approval.

## Package and CLI checks

The free operational runner builds, packs, installs, and invokes the real
binary through subprocesses:

```sh
npm run eval:operational
```

It records six separate scenarios:

1. the archive contains the `acc` bin and required `dist` files;
2. a temporary-prefix install exposes an invokable binary;
3. print-only flags are rejected without `-p`;
4. interactive startup refuses a non-TTY;
5. print mode with masked provider keys names the missing key and exits;
6. home-directory and filesystem-root startup refuse before model use.

Results go to the ignored `evals/results/operational/` directory. Independent
paid release checks also drive the packed CLI in print mode and exercise TUI
resume in a real terminal. They are never run automatically.

## Release standard

`evals/baselines/standards.json` contains the exact judge model, judge cases,
repeats, false-allow limit, and operational scenarios. The checker requires
explicit evidence paths; it never selects the newest result automatically.

```sh
npm run eval:standard -- \
  --standards evals/baselines/standards.json \
  --judge evals/results/<judge>.jsonl \
  --operational evals/results/operational/<operational>.jsonl
```

It exits nonzero for judge harness errors, false-allows, operational failures,
or metadata and case-set mismatches. Each axis prints on its own line.

## Historical baseline: 2026-09-17

The repository preserves the complete sanitized baseline from 2026-09-17 at
[`evals/baselines/2026-09-17-deepseek-v4-flash.json`](../evals/baselines/2026-09-17-deepseek-v4-flash.json).
It requested `deepseek-v4-flash`, which DeepSeek documented on that date as
routing to **DeepSeek-V4.1-Flash**.

| Historical axis | Result |
| --- | ---: |
| Judge outcomes | 180/180 scored, 0 errors |
| Judge false-allows | 0/105 |
| Judge false-refusals | 1/75 |
| Judge unstable cases | 1 (`stale-2`) |
| Task trials solved | 75/75 |
| Task trials clean | 75/75 |
| Smoke `pass^3` | 10/10 |
| Focused `pass^3` | 12/12 |
| Workflow `pass^3` | 3/3 |
| Operational scenarios | 6/6 |
| Independent packed CLI/TUI scenarios | 2/2 |

The task rows above are historical evidence, not an active or reproducible
embedded suite. The dated JSON retains the task composition, per-suite and
per-case results, usage, model-routing note, and source-result names without
rewriting the record.

That task evidence was a disclosed composition. A full 75-trial run exposed
four case-contract defects. After the contracts were corrected and checked,
only those four cases were rerun for three repeats; the other 21 cases were
retained. Task usage was 1,000,769 prompt tokens and 88,959 completion tokens.
The dated task-only cost range was about **$0.06–$0.21**.

The independent installed-product gate passed both approved live scenarios.
A fresh packed binary completed a real print-mode edit and passed its fixture
test. A real tmux TUI returned `E2E_TUI_OK`, reopened the same session through
`/resume`, replayed both messages, and exited cleanly. Observable usage was
11,960 prompt plus 552 completion tokens, with a dated cost range of about
**$0.00037–$0.00213**. The temporary package, workspaces, isolated homes, and
tmux session were removed.

## Evidence boundaries

- The dated Task/Case results describe the removed suite as it existed on
  2026-09-17; they are not a current release gate.
- The baseline covers one requested model ID on one date and environment.
- Raw transcripts can contain local paths and model text, so the repository
  tracks only the sanitized summary.
- Live judge runs and independent CLI/TUI checks cost money and require
  explicit approval. CI runs only offline tests.
