# Retain Recent User Prompts After Compaction

## Outcome

Change local compaction so a successful summary no longer replaces every prior non-system
message with only one assistant summary. Build a Codex-like replacement context that keeps the
newest prior user prompts within a 20,000 estimated-token budget, keeps the assistant summary and
its hidden continuation state, excludes old assistant/tool-call/tool-result messages, and preserves
the current pending user task outside the summary. Persist that exact replacement so manual and
automatic compaction behave the same after `/resume`.

## Success conditions

- The summarizer still receives the complete active history, including a completed tool round, but
  not the pending user task at the start of a new turn.
- After successful compaction, active context is ordered as `[system, retained prior user prompts,
  assistant summary, pending current user task if present]`.
- Retained prior prompts are selected newest-first and fit within a 20,000 estimated-token budget;
  old assistant messages, tool calls, and tool results are never retained verbatim.
- A string prompt at the oldest retention boundary may be copied and clearly truncated to fit the
  remaining budget without mutating its original message; a structured prompt is retained only if
  it fits whole.
- Manual `/compact`, automatic mid-run compaction, automatic step-zero compaction, `/resume`, and
  model continuation all use the same replacement history.
- A new compact record persists the exact non-system replacement, including a pending current task
  that was deliberately excluded from summarization. Legacy compact records without that field
  still restore as summary-only records.
- A failed or rejected summary leaves message identity, content, persistence, and current failure
  behavior unchanged.
- Rewind still reaches every original user checkpoint before a compaction, and the terminal view
  still shows the full visible conversation.

## Scope

- In scope: a 20,000-token retained-user selection helper; compaction replacement construction;
  pending-task handoff at the automatic step-zero boundary; compact-record persistence and legacy
  replay; focused regression coverage; user and design documentation that currently says every
  non-system message is removed.
- Out of scope: provider-native/Remote V2 compaction; retaining raw tool results or old assistant
  messages; restoring the removed `clearRecoverable` pass; changing the 80% automatic threshold,
  summary prompt, summary validation rules, context-window sizes, tool output caps, `/clear`,
  permission policy, or general session-log atomicity.
- Preserve: the assistant role and `SUMMARY_PREFIX` for the summary; provider-neutral continuation
  metadata; full-history summary input; terminal compaction lifecycle and wording; append-only
  session history; rewind semantics; all files under `.claude/`; unrelated user changes.

## Context and decisions

- `compactSession` currently sends `session.messages` plus the compaction instruction, validates the
  response, and installs `[system, summary]`. The new selection happens only after a valid summary
  exists, so failed compaction remains non-mutating.
- Use the repository's `estimateMessage`/`estimateMessages` accounting rather than adding a tokenizer.
  The constant is an estimated-token budget named for retained user prompts and set to `20_000`.
- Walk eligible prior user messages from newest to oldest, then restore chronological order in the
  replacement. Fully fitting messages remain the same objects in memory. If the oldest boundary is
  a string message, clone and truncate it with an explicit marker while guaranteeing the retained
  set remains at or below the budget. Do not partially rewrite structured content.
- The pending task at automatic step zero counts toward the trigger but remains outside the summary
  and outside the 20,000-token prior-prompt budget. Pass it into the successful replacement rather
  than popping it, writing a compact record, and merely pushing it back afterward; otherwise replay
  can lose a task whose original message record appears before the compact record.
- Extend the compact record with an optional full non-system `replacement` message array. New
  records store retained prompts, the summary message with continuation metadata, and any preserved
  pending task. `messagesOf` prefers `replacement` and falls back to the existing
  `summary`/`continuation` fields for old records. No session-version bump is needed because the new
  field is optional and old records remain readable.
- Keep the existing `summary`, `continuation`, and `replaced` fields for compatibility and reporting.
  `replaced` keeps its existing meaning: the count of non-system messages covered by the compaction
  input, even when a recent user prompt is also copied into the replacement. Token-freed reporting
  continues to use the estimated before/after difference.
- `appendCompact` must add every replacement message to the store's identity-based `written` set so
  a later `appendStep` does not persist retained prompts or the summary twice.
- Do not add retained prompts as new checkpoint records. `checkpointsOf` must continue to expose the
  original pre-compaction user records exactly once, allowing rewind across the compact marker.
- Keep the summary as an assistant message. Codex's provider-specific wire representation is not
  portable across this project's DeepSeek, Kimi, GLM, and other OpenAI-compatible providers.
- The repository ignores new files under `plans/`, while the earlier auto-compaction plan is already
  tracked. This plan therefore will not appear in ordinary `git status`; verify it by path and use
  an explicit force-add for this file only at final staging if the approved commit includes it.

## Verification strategy

- Unit tests: extend `src/tests/core/compact.test.ts`, `src/tests/core/context-threshold.test.ts`,
  `src/tests/core/step-zero-compact.test.ts`, `src/tests/core/store.test.ts`, and
  `src/tests/ui/agent.test.tsx`; add token/truncation cases to `src/tests/core/tokens.test.ts` only if
  shared token helpers change. Cover newest-first selection, exact 20,000-token enforcement, CJK
  accounting, string boundary truncation, structured-message whole-or-skip behavior, exclusion of
  assistant/tool messages, repeated compaction, failed summary identity preservation, hidden
  continuation, manual and automatic replacement order, pending-task persistence, legacy compact
  records, resume without duplication, and rewind across a compact record. Focused command:
  `npm run build && node --test dist/tests/core/compact.test.js dist/tests/core/context-threshold.test.js dist/tests/core/step-zero-compact.test.js dist/tests/core/store.test.js dist/tests/core/tokens.test.js dist/tests/ui/agent.test.js`.
- End-to-end boundary: run the built `acc` CLI in a real tmux terminal with an isolated temporary
  workspace and isolated `ACC_HOME`. Direct function calls and mocked model clients do not satisfy
  this gate; the model/provider remains live.
- E2E scenario: the verifier should draft two to four exact scenarios, including at least (1) manual
  `/compact` after multiple user prompts carrying unique harmless markers, followed by `/resume`,
  proving the latest compact record contains retained user messages plus exactly one assistant
  summary and the resumed CLI continues correctly; and (2) automatic compaction after a real large
  tool result under a low `ACC_COMPACT_AT`, proving the summarizer sees the result, the replacement
  keeps the exact user prompt but no raw tool result, and the same run completes. Include a
  step-zero/pending-task persistence scenario if the unit evidence cannot establish the on-disk
  ordering through the mounted UI. Inspect only isolated session records containing test data.
- E2E subagent: use the dedicated `acc-e2e` subagent after focused tests, full `npm test`, and the
  documentation build pass. It must not edit production code. It must first run the free build gate,
  draft the paid scenarios with keystrokes, source-derived oracles, and usage estimate, then stop for
  approval before any live model call.
- Authorization: live E2E calls spend real API tokens and require explicit user approval after the
  subagent drafts scenarios and a cost ceiling. The plan and its launch prompt do not authorize paid
  calls. No production service, push, or PR is authorized.
- Evidence: record focused and full test totals; documentation-build result; compact-record shape;
  active and resumed message-role order; retained-token total; absence of raw tool output and
  duplicate summary/prompt messages; terminal notice/final response; provider/model, observable
  usage and estimated cost; cleanup; and final tracked-file status.

## Version control

- Branch: `main` was clean before this plan file was created. At execution preflight, create
  `feat/retain-user-context-on-compact` from `main` while carrying this expected untracked plan
  file. Do not switch branches if any other change appears; stop and report it.
- Planned commits: 1

### Commit 1 — Retain recent prompts after compaction

- Covers: all implementation, persistence, tests, documentation, and this plan.
- Message: `feat(context): retain recent prompts after compaction`
- Before committing: present the exact branch action and commit subject as the repository preflight;
  obtain approval through the launch prompt; pass the focused tests, full `npm test`, docs build,
  independent approved `acc-e2e` run, secret inspection of every changed/staged file, stale-claim
  searches, and `git diff --check`. Stage only the reviewed files immediately before committing;
  use `git add -f plans/retain-recent-user-prompts-after-compaction.md` only for this ignored plan,
  then commit with `git commit -m "feat(context): retain recent prompts after compaction"`.

## Phase 1 — Build the Codex-like replacement context

### Step 1 — Select recent prior user prompts under the budget

- Purpose: preserve exact recent intent without carrying the bulky tool/assistant transcript.
- Actions: in `src/core/compact.ts`, add a named 20,000-token retention constant and a focused helper
  that filters user-role messages, walks newest-first, accounts with `estimateMessage`, returns
  chronological order, and handles the oldest string boundary with a non-mutating, explicitly
  marked truncation. Keep structured content only when it fits whole. Export only seams needed by
  direct tests.
- Expected result: the helper returns only user prompts, never exceeds its budget, keeps whole
  fitting message objects, and cannot mutate the summary input or original session history.
- Verification: add direct cases in `src/tests/core/compact.test.ts` for several small prompts, one
  oversized newest prompt, a partially fitting oldest boundary, CJK content, structured content,
  and histories containing assistant/tool messages; build and run the focused compact test.

### Step 2 — Install one complete successful replacement

- Purpose: make retained prompts part of compaction itself rather than a second clearing stage.
- Actions: update `compactSession` in `src/core/compact.ts` to construct
  `[system, ...retainedUsers, summary, ...postSummaryMessages]` only after summary validation. Give
  the automatic caller a narrow way to supply the held pending task as a post-summary message.
  Update `src/core/loop.ts` so failure restores the popped task exactly as today, while success uses
  the replacement already installed by `compactSession` and does not push a duplicate. Keep manual
  `/compact` on the same code path with no post-summary task.
- Expected result: manual, mid-run automatic, and step-zero automatic compaction share one ordering;
  the current task is neither summarized nor charged to the prior-prompt budget, and failures
  preserve the original objects.
- Verification: update `src/tests/core/compact.test.ts`,
  `src/tests/core/context-threshold.test.ts`, and `src/tests/core/step-zero-compact.test.ts` to assert
  exact summarizer input, follow-up request roles/content, no raw tool result, no duplicate pending
  task, before/after estimates, continuation survival, and failure identity.

## Phase 2 — Persist and replay the exact replacement

### Step 1 — Extend compact records compatibly

- Purpose: ensure retained prompts and held pending tasks survive process restart.
- Actions: in `src/core/records.ts`, add optional `replacement: Message[]` to compact records and make
  `messagesOf` reset to that array when present, otherwise reconstruct the legacy summary message.
  In `src/core/store.ts`, extend `SessionStore.appendCompact` to accept the full non-system
  replacement, add each replacement object to `written`, and append both the compatibility fields
  and replacement array. Update `src/tests/fakes.ts` and typed fake overrides. Keep
  `lastUsageOf`, `checkpointsOf`, `viewOf`, and `SESSION_VERSION` unchanged.
- Expected result: new sessions replay exactly what the in-memory model saw after compaction; old
  summary-only records still load; original user checkpoints and full view remain available.
- Verification: extend `src/tests/core/store.test.ts` for new-record round trip, legacy record
  fallback, hidden continuation, post-compaction append deduplication, repeated compactions, and
  rewind before/after the compact marker.

### Step 2 — Prove UI resume and step-zero ordering

- Purpose: catch integration mistakes that isolated record helpers cannot see.
- Actions: update `src/tests/ui/agent.test.tsx` expectations from summary-only restoration to retained
  user prompts plus one summary. Add or adapt a mounted-agent case where a task is already written,
  step-zero compaction holds it out of summarization, the compact record persists it after the
  summary, and `/resume` restores it once. Preserve spinner, notice, failure, and visible-history
  behavior.
- Expected result: mounted manual and automatic flows agree with core/store behavior, including
  across unmount and resume.
- Verification: run the compiled UI agent test and inspect the isolated record ordering asserted by
  the test.

## Phase 3 — Align documentation with retained context

### Step 1 — Update internal design and persistence documentation

- Purpose: remove the now-false invariant that every non-system message disappears.
- Actions: update `docs/agent-loop.md`, `docs/sessions.md`, and `docs/permissions.md`. Document the
  full-history summary input, newest-first 20,000-token user-prompt budget, boundary truncation,
  summary and pending-task order, replacement record replay, legacy fallback, unchanged checkpoint
  behavior, and why permission judging still uses complete `session.asked` rather than only the
  retained prompt subset.
- Expected result: a future maintainer can reconstruct active, persisted, resumed, and rewound state
  without reading tests or reintroducing raw-result clearing.
- Verification: search these documents for stale claims including `[system, summary]`, `whole
  conversation goes`, `drops everything`, and `nothing at all after a compaction`; review every
  remaining occurrence for correctness.

### Step 2 — Update user-facing compaction descriptions

- Purpose: make `/compact` and automatic compaction documentation match observable behavior.
- Actions: update `README.md`, `docs/features.md`,
  `www/src/content/docs/configure/commands.md`, and
  `www/src/content/docs/design/architecture.md` where they claim the whole conversation is replaced
  only by a summary. Explain that recent user prompts remain exact within a 20,000-token budget while
  older details and raw tool evidence are represented by the summary. Do not describe provider-native
  Remote V2 compaction as a feature of this project.
- Expected result: public docs describe one local compaction operation, not summary followed by a
  separate clear pass.
- Verification: run `npm run build --prefix www` and repository-wide stale-text searches; resolve
  broken links or contradictory statements.

## Phase 4 — Complete automated and independent verification

### Step 1 — Run repository gates and review the change

- Purpose: detect regressions and accidental scope changes before live testing.
- Actions: run the focused command from the verification strategy, then `npm test`,
  `npm run build --prefix www`, stale-claim searches, `git diff --check`, `git diff --stat`, and a
  full diff review. Confirm `.claude/` and unrelated files are untouched. Route failures back to the
  responsible phase and rerun every affected gate.
- Expected result: all automated checks pass and the diff contains only the planned feature, tests,
  docs, and plan artifact.
- Verification: record command totals and decisive assertions, not only exit codes.

### Step 2 — Run independent CLI scenarios

- Purpose: prove retention, compaction, persistence, and continuation through the actual terminal
  boundary and live provider.
- Actions: spawn the dedicated `acc-e2e` subagent only after Step 1 passes. Require it to follow the
  approval protocol in the verification strategy, run only approved scenarios in isolated paths,
  inspect terminal output and isolated session records, resume the compacted session, report
  evidence and verdict, and remove tmux sessions and temporary data afterward. It must not edit
  production code.
- Expected result: every approved scenario passes; retained prompts survive manual and automatic
  compaction/resume, raw tool results do not survive in the replacement, and the run continues with
  no provider or protocol error.
- Verification: require a concise scenario table, exact observations, usage/cost, cleanup status,
  final repository status, and an overall PASS. A failed or unauthorized E2E gate leaves the goal
  incomplete and blocks the commit.

## Final verification

- Unit-test result: the focused compiled suite, full `npm test`, and docs build pass with recorded
  totals. Regression evidence covers selection, truncation, failure, continuation, persistence,
  legacy records, resume, repeated compaction, and rewind.
- Subagent E2E result: the approved `acc-e2e` report shows PASS through the built CLI for manual and
  automatic compaction, isolated record inspection, resume, same-run continuation, and cleanup.
- Complete-goal checks: active and resumed replacements match; retained user messages estimate to
  no more than 20,000 tokens; pending tasks occur once and after the summary; summaries occur once;
  raw tool messages are absent from replacement; legacy records load; full view and checkpoints
  remain; no stale whole-history-removal claim remains; secret inspection passes; `.claude/` and
  unrelated work remain untouched; `git diff --check` is clean.
