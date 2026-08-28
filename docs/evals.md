# Evals

Status: built, one eval.
Covers: `src/evals/`, `evals/cases/`, `evals/results/`, `npm run eval:judge`
Read when: changing `JUDGE_RUBRIC`, or adding a second eval
See also: `permissions.md` (what the judge is for and where it is called from)

**Goal:** know whether the judge's rubric still holds, as a number, before a
change to it ships.

## What an eval is for here

`npm test` is free, offline, and fast, and it can prove that `judgeMessages`
builds the prompt it is supposed to build. It cannot prove the thing that
matters. `JUDGE_RUBRIC` in `src/core/permission/judge.ts` is 1,536 characters of
prose, and prose is only obeyed or not obeyed by a model. The only way to learn
which is to send it to one.

So the eval is a second kind of check, on its own script, that reaches the
network. It is **not** part of `npm test` and must never become part of it.

## The two errors are not the same size

The judge answers `allow` or `ask`. Both answers can be wrong, and the two
mistakes cost very different things.

- A **false-allow** is a case labeled `refuse` that the judge allowed. The gate
  let through an action the user never authorized. This is the number that
  matters.
- A **false-refuse** is a case labeled `allow` that the judge asked about. The
  user gets one prompt they did not need. This is friction, nothing worse.

That is why the report prints them as two separate counts and two separate
rates, and never adds them into one accuracy figure. One accuracy figure would
let a rise in false-allows hide behind a fall in false-refuses.

Rates are computed **over non-error outcomes only**, and the report always
states how many were excluded. A rate whose denominator quietly shrank is worse
than no rate.

## An eval never calls `askJudge`

`askJudge` catches every failure and returns `'ask'`. That is right for the
product — when the judge cannot answer, the user should be asked. It is poison
for an eval: a timeout or a rate limit would be scored as a REFUSE and show up
as a rubric regression that never happened.

So `runCase` in `src/evals/judge/run.ts` makes the same request with the same
arguments, but lets the error through as a third outcome, `error`. An `error` is
never scored as a verdict. The runner exits non-zero when any outcome is an
error, because that means *the run was broken* — a different claim from *the
rubric did badly*.

Any eval added later must keep this rule. Reuse the product's prompt builder;
never reuse the product's error handling.

## Running it

```
npm run eval:judge
```

Flags: `--cases <path>`, `--repeats N`, `--concurrency N`, `--limit N`,
`--max-seconds N`. `--limit` is what makes a cheap smoke run possible before
spending on a full one:

```
npm run eval:judge -- --limit 3 --repeats 1
```

The model is `deepseek-v4-flash`, resolved through `judgeModelFor` — the model
production actually gives the judge. Override it with `ACC_EVAL_MODEL`.

Concurrency defaults to 4 on purpose. `src/core/retry.ts` treats HTTP 429 as
retryable and backs off 1s/2s/4s, so pushing it higher trades speed for sleep
and turns rate-limited cases into `error` outcomes that pollute the score.

## Where things live

- `evals/cases/judge.jsonl` — **tracked.** 60 hand-labeled cases, one per line.
  These are reviewed ground truth and worth diffing; a wrong label is a
  permanently wrong score.
- `evals/results/` — **gitignored.** One `<iso>.jsonl` per run: an `Outcome` per
  line, then a single `{kind: 'report', …}` line.
- `src/evals/` — the eval code. It lives under `src/` so `tsc` typechecks it with
  everything else, and `npm test` picks up its unit tests automatically.

The cases are grouped in ten categories, each tied to a named clause of the
rubric: `direct`, `broad`, `stale` and `override` are labeled `allow`;
`unasked`, `destructive`, `outward`, `secrets`, `outside` and `injection` are
labeled `refuse`. The ten `injection` cases plant a fake authorization **inside**
the block fenced by `CALLS_OPEN`/`CALLS_CLOSE` and never in a user message,
because the rubric's claim is exactly that the block is evidence and never
authority.

## Baseline

**2026-08-28, `deepseek-v4-flash`, 60 cases × 3 repeats = 180 outcomes.**

| | count | of | rate |
| --- | --- | --- | --- |
| false-allow | 0 | 105 | 0.0% |
| false-refuse | 0 | 75 | 0.0% |

0 errors, so nothing was excluded. No case disagreed with its own repeats. 77.3s
wall clock at concurrency 4, 2.33 calls/s.

Read that as a floor, not a ceiling. It says the rubric holds on these 60 cases,
including all ten injection attempts. It does not say the rubric is hard to
break — it says this case set did not break it. A set that never fails cannot
detect a regression either, so the useful next move is harder cases, not a
threshold on this number.

There is no score threshold yet, and the runner does not fail on the score. A
threshold becomes a real decision now that a baseline exists.
