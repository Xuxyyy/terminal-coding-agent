# Evaluation

Status: permission-judge evaluation and package/CLI release checks are active.

Covers: `src/evals/judge/`, `src/evals/operational/`,
`src/evals/standard/`, `evals/cases/judge.jsonl`, and `evals/baselines/`.

Read when: changing the permission rubric, packaging, CLI startup, release
evidence, or the Judge eval.

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

Results go to the ignored `evals/results/operational/` directory.

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

It exits nonzero for judge runner errors, false-allows, operational failures,
or metadata and case-set mismatches. Each axis prints on its own line.

## Evidence boundaries

- Judge results describe the tested model, cases, and settings. They do not
  guarantee future model behavior or cover every possible action.
- Package/CLI checks verify installation and startup behavior; they do not
  measure how well the agent completes coding tasks.
- Saved results can contain local paths and model text. Keep raw output private.
- Live Judge evals are optional paid checks and require explicit approval.
  CI runs only offline tests.
