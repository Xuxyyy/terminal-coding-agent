# Evaluation

Status: four layers implemented, with versioned standards and a 2026-09-17
baseline.

Covers: `src/evals/`, `evals/cases/`, `evals/baselines/`, and the
`eval:*` npm scripts.

Read when: changing the permission rubric, agent loop, tools, task cases,
packaging, CLI startup, or release evidence.

## What this system claims

The evaluation system answers four different questions without hiding them in
one score:

1. **Offline correctness:** do the loaders, graders, fixtures, reports,
   standards, and product code pass deterministic tests?
2. **Focused coding capability:** can the real agent complete small tasks that
   isolate one capability?
3. **Complete workflows:** can those capabilities connect across an
   inspect → diagnose → edit → verify turn?
4. **Operational behavior:** does a packed and installed CLI start, reject bad
   invocations, and protect unsafe workspaces as expected?

The permission judge is reported beside these layers as its own safety axis.
It measures false-allows and false-refusals separately. There is deliberately
no overall accuracy number: success on coding tasks cannot cancel a safety
failure.

## Layer 1: free offline tests

`npm test` typechecks first and then runs the complete Node test suite. No
model, provider key, network request, or paid call is used.

The evaluator tests prove that:

- all 25 task cases load with unique IDs and the expected suite/category;
- every new reference solution passes its deterministic checks;
- every new counterexample fails at least one primary check;
- solution overlays cannot escape the temporary fixture;
- transcript checks validate only a named tool and optional argument/result
  patterns, without prescribing a full tool order;
- scoring keeps `solved`, `clean`, errors, suites, categories, `pass^k`, token
  splits, and metadata distinct;
- operational subprocesses distinguish timeouts, nonzero exits, and launch
  errors, mask provider keys, and always clean up scratch directories;
- the standards checker rejects malformed, mismatched, unsafe, unclean, or
  regressed evidence.

Focused evaluator gate:

```sh
npm run build
node --test "dist/evals/task/*.test.js" \
  "dist/evals/operational/*.test.js" \
  "dist/evals/standard/*.test.js"
```

## Layers 2 and 3: real-agent task trials

The task evaluator copies one case workspace into a fresh temporary directory,
runs the real `runHeadless` loop with a real model, grades the final files and
transcript, records the result, and removes the fixture. Cases run sequentially
because settings are module-global.

```sh
npm run eval:task:smoke
npm run eval:task:focused
npm run eval:task:workflow
npm run eval:task:all
```

Useful flags are `--cases <path>`, `--suite smoke|focused|workflow`,
`--repeats N`, `--limit N`, and `--max-seconds N`. Filtering by suite happens
before limiting. `ACC_EVAL_MODEL` overrides the requested model ID.

### Outcome vocabulary

- `solved`: every deterministic check passed.
- `clean`: no file outside `allowedWrites` changed, and the harness did not
  error.
- `pass`: both solved and clean.
- `fail`: the harness ran, but the result was not a clean solution. Timeouts
  are failures, not harness errors.
- `error`: the trial itself was unusable, for example because the provider or
  fixture failed. Errors are excluded from rates and block the standard.
- `pass^3`: every one of a case's three scored trials passed. This is a
  reliability measure, not best-of-three.

The grader is code, never a model. Checks cover commands, file existence or
absence, content, regex matches, unchanged files, exact-answer patterns,
permission prompts, and narrowly scoped transcript evidence. Open-ended prose
quality is not claimed.

### Case inventory

The ten preserved smoke cases are:

`already-done`, `answer-needs-grep`, `ask-edits-stops-a-write`,
`create-to-spec`, `fix-failing-test`, `grep-narrow`, `no-deleting-the-test`,
`outside-the-root`, `read-truncation-repair`, and `rename-across-files`.

The twelve focused cases are:

- diagnosis and verification: `diagnose-indirect-failure`,
  `diagnose-state-leak`, `verify-after-fix`, `write-regression-test`;
- build, scope, and instructions: `repair-type-contract`,
  `repair-build-config`, `preserve-user-wip`,
  `follow-project-instructions`;
- file operations and recovery: `move-module-and-imports`,
  `recover-wrong-command`, `recover-incomplete-fix`,
  `bash-tail-diagnostic`.

The three workflow cases are `workflow-bug-with-regression`,
`workflow-small-feature`, and `workflow-preserve-api-refactor`.

Focused cases isolate one primary capability. Workflow cases deliberately
combine capabilities but remain dependency-free and deterministically graded.
No fixture installs packages or accesses the network.

## Permission-judge safety eval

```sh
npm run eval:judge
```

The judge eval runs 60 hand-labeled permission decisions. A false-allow is a
refuse-labeled action that the judge allowed; a false-refusal is an
allow-labeled action that the judge asked about. Provider and timeout failures
are recorded as `error`, never silently converted into a safe-looking verdict.

Flags are `--cases <path>`, `--repeats N`, `--concurrency N`, `--limit N`, and
`--max-seconds N`.

## Layer 4: installed-product checks

The free runner builds, packs, installs, and invokes the real binary through
subprocesses:

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

Results go to the ignored `evals/results/operational/` directory. Paid packed
print-mode and real-terminal resume checks are separate release gates and are
never run automatically.

## Frozen release standard

`evals/baselines/standards.json` contains the exact model, case IDs, repeats,
operational scenarios, and capability floors. The checker requires explicit
evidence paths; it never selects whichever result happens to be newest.

```sh
npm run eval:standard -- \
  --standards evals/baselines/standards.json \
  --judge evals/results/<judge>.jsonl \
  --task evals/results/task/<task>.jsonl \
  --operational evals/results/operational/<operational>.jsonl
```

It exits nonzero for any harness error, judge false-allow, unclean task trial,
smoke regression, operational failure, metadata/case-set mismatch, or
focused/workflow suite or category result below its floor. Each axis prints on
its own line. There is no combined score.

When only corrected cases are rerun, `npm run eval:compose-task` can replace
those case trials in a full result. It validates repeat counts, model, Git
revision, suite, Node version, and platform, preserves the original case order,
recomputes the report, and records both source result names and every replaced
case ID. Composed evidence must be disclosed; it is not presented as one
continuous run.

## 2026-09-17 baseline

Requested model: `deepseek-v4-flash`. On 2026-09-17 DeepSeek documented that
this compatibility ID routes to **DeepSeek-V4.1-Flash**. This baseline is not a
direct comparison with the August run against the earlier model generation.

Tracked sanitized evidence:
[`evals/baselines/2026-09-17-deepseek-v4-flash.json`](../evals/baselines/2026-09-17-deepseek-v4-flash.json).

| Axis | Result |
| --- | ---: |
| Judge outcomes | 180/180 scored, 0 errors |
| Judge false-allows | 0/105 |
| Judge false-refusals | 1/75 |
| Judge unstable cases | 1 (`stale-2`) |
| Task solved | 75/75 |
| Task clean | 75/75 |
| Smoke `pass^3` | 10/10 |
| Focused `pass^3` | 12/12 |
| Workflow `pass^3` | 3/3 |
| Operational scenarios | 6/6 |
| Independent packed CLI/TUI scenarios | 2/2 |

The task evidence is a disclosed composition. A full 75-trial run exposed four
case-contract defects. After those contracts were fixed and passed their
offline reference/counterexample tests, only the four affected cases were run
again for three repeats. The composed report retains the other 21 cases and
names both source files and the four replacements in metadata.

Task usage was 1,000,769 prompt tokens and 88,959 completion tokens, 1,089,728
total. The current usage event does not expose cache-hit tokens. Using the
published 2026-09-17 off-peak V4.1 Flash rates gives a task-only range of about
**$0.06–$0.21**: the lower bound treats all input as cache hits, and the upper
bound treats all input as cache misses. Output uses the published output rate.
Judge token usage is not emitted, so no false exact total cost is claimed.

The independent installed-product gate also passed both approved scenarios. A
fresh packed binary completed a real print-mode edit, changed only the requested
file, passed its test, emitted 125 parseable JSON event lines ending in
`stopped: done`, and stored no headless session. A real tmux TUI returned exactly
`E2E_TUI_OK` without tools, exited, reopened the same session through `/resume`,
replayed both messages, and exited cleanly. Observable usage was 11,960 prompt
plus 552 completion tokens; the dated cost range was about
**$0.00037–$0.00213**. All temporary packages, workspaces, isolated homes, and
the tmux session were removed, and repository status was unchanged.

Raw JSONL stays local and ignored:

- judge: `evals/results/2026-09-17T15-35-39-533Z.jsonl`;
- full task source: `evals/results/task/2026-09-17T15-46-50-206Z.jsonl`;
- corrected four-case source:
  `evals/results/task/2026-09-17T15-57-57-886Z.jsonl`;
- composed task evidence:
  `evals/results/task/2026-09-17T15-57-57-886Z-composed.jsonl`;
- operational: `evals/results/operational/2026-09-17T16-05-03-437Z.jsonl`.

## Evidence boundaries

- Passing deterministic cases does not measure subjective code quality.
- The baseline covers one requested model ID on one date and environment.
- `pass^3` is only evidence about these cases; it is not a general success
  probability.
- The raw transcripts can contain local paths and model text, so only sanitized
  summaries are tracked.
- Live model evals and independent CLI/TUI checks cost money and require
  explicit approval. CI runs only offline tests.
