---
name: tui-e2e
description: Verify a focused behavior in a real terminal app through tmux, using screen and file evidence. Use when a changed interactive flow needs a real run. App-specific setup comes from the caller.
---

# Focused terminal verification

Start with one small scenario that reaches the changed behavior. Add another
only when needed to answer the caller's question. Use a temporary workspace
and redirect app state into it. Build the current code before testing, or use
an existing successful build confirmed to match it. Seed only required files.

## Approval and cost

Run free checks within the task's scope without extra approval. Before paid
API work, give the parent agent the task, pass conditions, provider and model,
permission mode, setting overrides, and approximate cost and scope. For requested
ACC e2e tests, the parent gives the user the estimate before launch; no default
spending limit or separate budget approval applies. For other paid work, the
parent obtains approval unless the work is already covered by existing approval.
Confirm the running app's model and mode before sending a paid prompt. If they
differ from the approved plan, correct the setup or obtain approval for the
change. Never switch providers or broaden permissions silently.

Follow the caller's cost policy. For ACC e2e tests, estimate the agreed scope
including tool rounds, judges, retries, and subagents before launch. Track usage
across attempts and report recorded cost and uncertainty afterward; missing usage
is not zero. Do not stop agreed ACC e2e work solely because usage is missing,
cost exceeds the estimate, or an agent-managed default budget is reached. An
explicit user spending limit still controls. Keep agreed task, attempt, and
runtime limits. A cost estimate is not a billing cap; in-flight calls and missing
usage can leave final cost uncertain.

## Drive and observe

Use a unique tmux session for each run and a fixed terminal size. Never kill an
unrelated session. The caller supplies the launch command and workspace.
Send literal text and key presses separately:

```sh
tmux send-keys -t "$ACC_TEST_SESSION" -l 'the task to test'
tmux send-keys -t "$ACC_TEST_SESSION" Enter
tmux capture-pane -t "$ACC_TEST_SESSION" -p -S -300
```

Poll for app output or file changes with a bounded timeout. Do not mistake
text echoed from your prompt for app output. Include scrollback when needed.
To check that something does not happen, watch for a stated duration and first
confirm the app reached the step where it could happen.

Derive expected app text and file effects from current source. Judge model
responses by actions and results rather than exact prose. Observe the changed
step and check the final result. When the task writes data, inspect the actual
file or saved record. A model claiming success is not sufficient evidence.

## Outcomes and boundaries

- PASS: the relevant path ran and its expected behavior was observed.
- FAIL: the relevant path ran and violated the expected behavior. Quote evidence.
- UNTESTED: the path was not reached, a prerequisite failed, or the check was
  skipped. Include the reason; never turn a blocked check into a pass.

For a timeout, report what had been reached and how long you waited. It is a
failure only when the evidence establishes a violation; otherwise it is untested.
Report problems without fixing code. Stay within the scenario and leave unrelated
investigation to the caller. Never expose credentials. Capture evidence before
cleaning up only this run's processes and temporary files, including after failure.
Save requested transcripts and evidence outside the temporary workspace before
removing it. For acc runs, use [the transcript exporter](references/acc-transcripts.md).
Saved acc results remain until the user deletes them; do not prune older runs.

## Short report

Return the short report in chat, linking to the saved transcript separately:

- Verdict: PASS, FAIL, or UNTESTED with one sentence explaining why.
- A small table with one row per planned scenario: task, result, decisive evidence.
  Include skipped checks as UNTESTED. Overall PASS requires every planned check
  to pass; use FAIL if any failed, otherwise UNTESTED if any remain untested.
- Only the screen or file excerpts needed to support the result. Include timing
  when it matters and a suspected source location for failures when known.
- Actual provider, model, permission mode, and any overrides; observable usage
  and estimated cost, any explicit user spending limit, and missing usage;
  cleanup status and any leftovers; absolute links to the saved transcript
  and the task index containing earlier attempts.

Keep the report proportional to the test. Do not add a full terminal transcript
or a step-by-step narrative.
