# Run Auto Compaction Between Model Requests

## Outcome

Auto compaction uses one configurable threshold and runs at a safe boundary immediately before the next normal model request. The trigger uses the last provider-reported context total plus estimates for messages added locally since that measurement. When the threshold is reached, the complete uncleared history is summarized first; only after a valid summary exists is the detailed history replaced. A failed automatic summary leaves history unchanged and stops the current run.

## Success conditions

- A tool result is recorded locally, counted in the projected context, and available to the summarizer before the next model request.
- Crossing `contextWindow * ACC_COMPACT_AT` between two model requests starts compaction in the same run instead of clearing tool results or waiting for another user message.
- At the start of a new user turn, the pending user message counts toward the trigger but is excluded from the summary and restored unchanged after compaction.
- Successful auto compaction installs the summary, removes the detailed prior history, and continues with the next normal model request.
- Failed auto compaction emits a visible error, preserves the original history, emits the completion event needed to end the spinner, and stops without sending another normal model request.
- Manual `/compact`, manual `/clear`, session persistence, rewind across a compaction, summary validation/retry, `ACC_COMPACT_AT`, and the measured `/context` readout keep their existing behavior.
- There is no separate recoverable-result clearing pass, clearing-exhaustion state, or clear-specific threshold event.

## Scope

- In scope: the core turn-loop trigger and ordering, removal of automatic recoverable-result clearing, session and host state made obsolete by that removal, UI event handling and wording affected by the new flow, regression tests, design documentation, and user documentation.
- Out of scope: changing the compaction prompt, summary acceptance rules, model context-window sizes, tool-level output caps, manual `/compact` semantics, manual `/clear` semantics, session record format, rewind behavior, or provider APIs.
- Preserve: unrelated worktree changes; everything under `.claude/`; the hard request-fit guard based on the physical model context window; full original session records that allow rewind across compaction.

## Context and decisions

- Approved scope amendment (2026-09-17): the first independent E2E run proved that supported
  reasoning-capable providers need hidden continuation metadata preserved across the request
  boundary. Implement one provider-neutral optional continuation path for normal assistant
  messages and compact summaries, include it in token estimates, and persist it as an optional
  compact-record field. The user approved this expansion after discussing DeepSeek, Kimi, GLM,
  and model switching; provider-name branches in the agent loop remain out of scope.

- `projectedTokens()` in `src/core/session.ts` already implements the settled trigger calculation: provider-reported `lastContextTokens` plus the estimated message delta since `measuredAt`. Keep that calculation and verify it with regression coverage.
- `runAgent()` in `src/core/loop.ts` appends assistant tool calls and actual tool results before returning to the top of the loop. That top-of-loop boundary is where auto compaction must run before the next `streamStep()` call.
- Locally recorded and not-yet-sent are different states. Tool results must be in `session.messages` before the trigger check so the estimate uses their real content and the summarizer can preserve their evidence.
- A pending step-zero user task is different from a tool result: include its estimate in the trigger decision, temporarily remove it from the compaction input, then restore the same message object after success or failure.
- The post-compaction cleanup is `compactSession()` installing `[system, summary]`. Do not call `clearRecoverable()` afterward; successful replacement leaves no old tool results for it to clear.
- Remove `src/core/clear.ts`, its isolated tests, `Session.clearingExhausted`, and the `context_cleared` event if repository-wide reference checks confirm they have no remaining purpose. Preserve `clearSession()` and the `/clear` command, which are unrelated.
- Keep one auto-compaction threshold. The final request-fit comparison with the model's physical context window remains a safety guard, not a second compaction or clearing policy.
- Preserve the existing once-per-run `compaction threshold reached` notice and `compact_start`/`compact_end` spinner lifecycle unless implementation evidence shows the notice cannot remain truthful.
- On an automatic compaction failure, restore any held-aside user task, leave all prior history intact, emit `compact_end`, report that compaction failed and the run stopped, emit `turn_end`, and return. Do not fall back to result clearing or continue into another normal model request.

## Verification strategy

- Unit tests: update `src/tests/core/context-threshold.test.ts`, `src/tests/core/step-zero-compact.test.ts`, and relevant cases in `src/tests/ui/agent.test.tsx`; retain `src/tests/core/compact.test.ts` coverage for shared summary validation and replacement. Cover an actual-plus-delta crossing, an under-threshold boundary, complete tool-result visibility to the summarizer, same-run continuation after success, pending-user-message exclusion and restoration, balanced compaction events, persistence of the compact record, and failure preserving history while stopping before the next request. Delete `src/tests/core/clear.test.ts` only with the obsolete module. Run `npm run build`, then `node --test dist/tests/core/context-threshold.test.js dist/tests/core/step-zero-compact.test.js dist/tests/core/compact.test.js dist/tests/ui/agent.test.js`, followed by `npm test`.
- End-to-end boundary: the built `acc` CLI in a real tmux terminal, pointed at an isolated throwaway workspace and isolated `ACC_HOME`; internal function calls or a mocked UI do not qualify.
- E2E scenario: after unit gates pass, the `acc-e2e` subagent must draft two feature scenarios with exact keystrokes and source-derived oracles. The scenarios must include (1) one prompt that reads a deliberately large file under a low `ACC_COMPACT_AT`, crosses the threshold after the real tool result, compacts before the follow-up model request, and finishes the same run with a sentinel from the file; and (2) a preservation check showing manual `/compact` still compacts directly while idle. Inspect the terminal and isolated `session.jsonl` to prove the compact record ordering, continued final answer, absence of recoverable-clear markers, and unchanged manual result notice. Clean up tmux and the throwaway workspace afterward.
- E2E subagent: dedicated `acc-e2e` agent. It must not edit production code. It must first run the free build gate, draft two to four feature scenarios and their estimated usage, then stop so the parent can obtain approval before any paid model call.
- Authorization: the E2E feature scenarios use a live model and spend real API tokens. The plan is not approval. Before the paid run, present the drafted scenarios, estimate, and default proposed ceiling of $0.03 to the user and obtain explicit approval. No production service, push, or PR action is authorized.
- Evidence: record focused and full test command results; for E2E, record the rendered notice/final response, relevant ordered session-record facts without exposing secrets, model and observable token usage, cost estimate, cleanup result, and whether tracked repository files changed during verification.

## Version control

- Branch: create `feat/auto-compact-between-requests` from the current `main` after rechecking the worktree. The worktree was clean before this plan file was created; preserve any later or unrelated changes and do not switch branches until the user approves the launch prompt.
- Planned commits: 1
- Preflight: before implementation, present the exact branch action and commit message below. Branch creation, staging, and committing are authorized only when the user explicitly approves them or sends the launch prompt provided with this plan.

### Commit 1 — Auto compact at request boundaries

- Covers: all implementation, tests, documentation, and this plan artifact.
- Message: `feat(context): compact automatically between model requests`
- Before committing: inspect every changed and staged file for credentials or sensitive local data; require the focused tests, full `npm test`, and the approved independent `acc-e2e` feature run to pass. If the paid E2E run is not authorized, leave the change uncommitted and report that the required gate is incomplete.

## Phase 1 — Replace clear-first pressure handling with boundary compaction

### Step 1 — Consolidate the threshold decision at the request boundary

- Purpose: make the single threshold control auto compaction before every next model request, using real provider usage plus actual locally recorded pending content.
- Actions: refactor the threshold blocks in `src/core/loop.ts` into one boundary flow that runs for step zero and later steps before `streamStep()`. Compute the trigger before temporarily removing a step-zero user task. For later steps, leave completed tool-call/output pairs in the compaction input. Emit the existing threshold notice at most once per run, run `compactSession()` with streamed summary text suppressed, account for compaction usage, restore a held task, and continue to the normal request on success.
- Expected result: both new-turn and mid-turn boundaries use the same projected trigger, and no normal request is sent with over-threshold detailed history when compaction succeeds.
- Verification: focused core tests demonstrate call ordering: normal request N, compaction request containing the full completed tool round, then normal request N+1 using the installed summary.

### Step 2 — Make automatic compaction failure terminal for the run

- Purpose: prevent repeated compaction attempts, context overflow, or continuation without a safe compacted state.
- Actions: in `src/core/loop.ts`, handle a `null` compaction result by restoring any pending task, preserving history, emitting an accurate stopped-error message plus `compact_end` and `turn_end`, and returning before `streamStep()`. Update affected UI expectations without changing manual `/compact` failure wording.
- Expected result: an auto-summary transport failure or two rejected summaries leaves the conversation unchanged and ends the active run cleanly.
- Verification: regression tests assert original message identity/content, no compact store record, balanced start/end events, one terminal error, `turn_end`, and no later normal model call.

### Step 3 — Remove obsolete automatic result-clearing machinery

- Purpose: ensure the summarizer always sees full tool evidence and keep the code aligned with the one-threshold design.
- Actions: remove the `clearRecoverable` import and calls from `src/core/loop.ts`; remove `clearingExhausted` from the `Session` type and its initialization/reset paths in `src/core/session.ts`; remove `context_cleared` and any now-unused host/UI handling from `src/core/host.ts` and `src/ui/agent.ts`; delete `src/core/clear.ts` and `src/tests/core/clear.test.ts` after a repository-wide reference check. Do not alter `clearSession()` or `/clear`.
- Expected result: no automatic path mutates prior tool results into cleared markers, and no dead state or event remains.
- Verification: `rg` finds no references to `clearRecoverable`, `CLEARED_*`, `clearingExhausted`, or `context_cleared`; TypeScript builds cleanly; `/clear` unit/UI coverage still passes in the full suite.

## Phase 2 — Rebuild regression coverage around the new behavior

### Step 1 — Test projected mid-turn compaction

- Purpose: prove the trigger includes known tool output that was added after the last provider measurement.
- Actions: rewrite the clear-first and never-compact-mid-run cases in `src/tests/core/context-threshold.test.ts`. Use a recording fake model to make the provider-reported total remain below the threshold while an actual large tool result pushes `projectedTokens()` over it. Assert that the compaction request includes the unmodified result, the next normal request includes the summary instead of detailed history, and an under-threshold delta does not compact.
- Expected result: the tests distinguish provider measurement, pending estimated delta, compaction request, and follow-up request without relying only on final state.
- Verification: build and run `node --test dist/tests/core/context-threshold.test.js`.

### Step 2 — Preserve step-zero and shared compaction guarantees

- Purpose: retain safe handling of new user input and the established summary/store invariants.
- Actions: update `src/tests/core/step-zero-compact.test.ts` to remove clearing-exhaustion cases while preserving assertions that the pending task counts toward the trigger, is absent from the summarizer request, and is restored as the last message. Keep or extend `src/tests/core/compact.test.ts` for full-history input, no tool definitions, validation retry, atomic replacement, measurement reset, and one compact store record.
- Expected result: the new unified boundary does not aim the summary at a fresh task or weaken atomic compaction.
- Verification: build and run `node --test dist/tests/core/step-zero-compact.test.js dist/tests/core/compact.test.js`.

### Step 3 — Verify user-visible lifecycle behavior

- Purpose: keep the TUI truthful while auto compaction moves into an active run.
- Actions: update `src/tests/ui/agent.test.tsx` for the once-per-run threshold notice, `Compacting…` phase, hidden summary stream, successful same-run continuation, and terminal auto-compaction failure. Preserve the existing manual `/compact` success/failure notices.
- Expected result: automatic compaction is visible while running but does not print its raw summary, and manual behavior is unchanged.
- Verification: build and run `node --test dist/tests/ui/agent.test.js`, then run the complete `npm test` gate.

## Phase 3 — Align design and user documentation

### Step 1 — Rewrite the context-pressure design description

- Purpose: prevent the removed clear-first and no-mid-run design from being reintroduced based on stale documentation.
- Actions: update `docs/agent-loop.md` to describe the single projected threshold, the boundary after completed tool results and before the next request, step-zero pending-task handling, summary-first history replacement, terminal failure behavior, and the separate physical request-fit guard. Remove the clear-operation table, clearing-exhaustion state, and the section arguing against mid-run summaries. Update `docs/sessions.md` so it no longer claims `compactSession` has only the old two caller locations.
- Expected result: internal design docs match the implemented ordering, safety reasoning, and storage behavior.
- Verification: search the docs for stale claims including `clearRecoverable`, `clearingExhausted`, `clearing runs first`, `never mid-run`, and `send your next message and it will compact first`; review every remaining match for correctness.

### Step 2 — Update user-facing behavior documentation

- Purpose: make the public description match what users see.
- Actions: update `docs/features.md` and `www/src/content/docs/configure/commands.md` to explain that auto compaction checks projected usage between model requests, summarizes complete history before removing details, continues the same run on success, and stops with history intact on failure. Preserve the separate descriptions of manual `/compact` and `/clear`.
- Expected result: no public page tells users that old results are cleared before compaction or that compaction waits for the next user message.
- Verification: run `npm run build --prefix www` in addition to repository-wide stale-text searches.

## Phase 4 — Complete automated and independent verification

### Step 1 — Run repository gates and inspect the change

- Purpose: catch type, regression, documentation-build, and accidental-scope failures before live testing.
- Actions: run the focused compiled tests, `npm test`, and `npm run build --prefix www`. Inspect `git diff --check`, `git diff --stat`, and the full diff. Confirm `.claude/` is untouched and unrelated files are not included.
- Expected result: all automated gates pass and the diff contains only the planned behavior, tests, docs, and plan.
- Verification: save the commands and pass/fail summaries for final evidence; route any failure back to the responsible phase and rerun all affected gates.

### Step 2 — Run the independent CLI feature test

- Purpose: prove the behavior through the real terminal, model, and session store rather than only mocks.
- Actions: spawn the dedicated `acc-e2e` subagent only after Step 1 passes. Have it follow its feature-run protocol: draft scenarios and usage estimate, pause for explicit paid-run approval, then run only the approved scenarios in an isolated workspace without modifying production code.
- Expected result: the real CLI compacts after a large tool result and before its follow-up request, finishes that same prompt, writes the expected compact ordering, leaves no clear markers, and retains manual `/compact` behavior.
- Verification: require the subagent's scenario table, decisive terminal/disk evidence, usage/cost disclosure, cleanup result, and PASS verdict. A missing approval or unavailable delegation leaves this required gate incomplete; do not replace it with a same-context check.

## Final verification

- Unit-test result: `npm run build`, the four focused compiled test files, full `npm test`, and the docs-site build must all pass with recorded output summaries.
- Subagent E2E result: the approved `acc-e2e` feature run must report PASS for every planned scenario, include terminal and session-file evidence, and confirm cleanup. Otherwise the goal is not complete and no commit should be created.
- Complete-goal checks: repository-wide searches show no obsolete automatic-clear symbols or stale clear-first/no-mid-run documentation; manual `/compact` and `/clear` tests remain green; failed auto compaction preserves history and stops; secret inspection passes before staging; `git diff --check` is clean; `.claude/` and unrelated user changes remain untouched.

## Execution evidence

- Pre-E2E automated gates: `npm run build` passed; the four planned focused compiled test files
  passed 72/72; `npm test` passed 970/970; `npm run build --prefix www` passed with all internal
  links valid; stale-symbol and diff checks passed.
- Independent E2E run 1: automatic compaction reached the correct boundary, stored the complete
  32,042-character tool result before one compact record with `replaced: 3`, showed the notice
  and spinner, and contained no removed clear markers. Its follow-up request failed with HTTP
  400 because hidden continuation metadata had been discarded. Manual `/compact` passed with
  `replaced: 2`. Cleanup passed, tracked repository state was unchanged, observable persisted
  usage was 3,462 tokens, and the conservative total remained below the approved $0.03 ceiling.
- Scope-amendment focused gate: `npm run build` plus client, loop, compaction, store, token,
  threshold, step-zero, and UI compiled tests passed 147/147. Coverage includes hidden-state
  streaming, tool-round replay, compact replacement, compact-record reload, token estimation,
  and model switching.
- Final automated gates: the planned four focused compiled test files passed 74/74; full
  `npm test` passed 975/975; `npm run build --prefix www` passed with all internal links valid;
  stale-symbol, `.claude/`, and `git diff --check` checks passed.
- Independent E2E rerun: both approved DeepSeek v4 Flash scenarios passed. Automatic
  compaction read the real 32,042-character tool result, showed the threshold notice and
  spinner, wrote a compact record after that result with `replaced: 3` and nonempty opaque
  continuation metadata, then returned `AUTO_COMPACT_SENTINEL_7F3A` in the same run without
  the earlier provider error. Manual `/compact` showed `compacted 2 messages, ~0 tokens freed`,
  wrote `replaced: 2` with nonempty continuation metadata, and the next turn returned
  `AFTER_MANUAL_COMPACT` without an automatic notice or provider error. No recoverable-clear
  marker appeared. Observable persisted usage was 8,529 tokens; estimated complete cost was
  about $0.008 and remained below the approved additional $0.03 ceiling. Both tmux sessions
  and the isolated workspace were removed, tracked repository status matched the baseline,
  and `.claude/` remained untouched.
