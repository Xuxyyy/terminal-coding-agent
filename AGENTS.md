# Public repository safety

- This repository is public. Never put credentials, private transcripts, personal
  data, or private machine paths in tracked files. Use placeholders in examples.
- Before staging, committing, creating a pull request, or pushing, inspect all
  changed and staged files for secrets and sensitive local data. Check tracked
  files explicitly; do not rely on `.gitignore` alone. Never stage credential
  files. A sanitized `.env.example` may contain placeholders only.
- If sensitive data may already be tracked or present in Git history, stop and
  warn the user without displaying it. Do not commit or push until resolved.

# API credentials and test approval

- `DEEPSEEK_API_KEY` supplies both the DeepSeek coding model and the Auto-mode
  permission judge. Preserve this single-provider setup.
- Actual key values and file locations belong only in private configuration
  outside this repository. Read the credential-discovery section of the agent's
  private user-level instructions for the local configuration and loading steps.
  If unavailable, ask for the private configuration location, never key values.
- Load only the needed keys into the approved command's environment. Never copy
  them into the project, print them, dump the environment, or enable shell tracing
  while handling credentials. Loading credentials does not authorize spending.
- Keep unit and simulated tests key-free, using fakes and the existing offline
  test setup. Do not load real credentials for these tests.
- Before any live API test, obtain approval for the scenario, provider/model,
  permission mode, overrides (including none), estimated cost, and spending limit.
  Include coding, permission-judge, retry, and subagent calls in the scope and
  estimate. Existing approval applies only within its agreed scope and limit.
- Keep private live-test transcripts and evidence outside the repository.

# End-to-end testing

- After relevant unit checks pass, automatically delegate a focused real test
  to the `acc-e2e` subagent in this chat when a feature, fix, or refactor affects
  the agent loop or its connected behavior. Do this before reporting completion.
  This includes tools, permissions, sandboxing, streaming, cancellation,
  subagents, session persistence, rewind, and terminal interaction with the loop.
- Give the subagent the change, expected behavior, and relevant source locations.
  Start with one small task that reaches the changed behavior. For a fix,
  exercise the original failure. Add another scenario only when needed; do not
  turn this into a broad regression run.
- Run the real acc CLI in a temporary workspace with only the needed files and
  isolated app state. Observe the changed step and check the result; a final
  answer alone does not prove that the changed behavior ran.
- Run key-free checks without extra approval. Before any live API work, present
  the scenario, provider/model, permission mode, overrides, estimated cost, and
  spending limit. Obtain approval unless existing approval already covers it.
- Use the spending limit in `.codex/agents/acc-e2e.toml` for the whole verification
  task. Pass accumulated spend to each subagent invocation, including retries
  and reruns after fixes. Obtain approval before increasing the limit.
- The subagent reports evidence and cleans up; the parent fixes failures caused
  by the change and reruns affected checks within the approved scope. Report
  failures, skipped checks, and verification limits.
- Save transcripts and selected evidence under `~/.acc/e2e-runs/`, with one
  folder per verification task. Pass that folder to retries so each attempt
  stays together. Link the saved transcript in the final report. Clean up the
  temporary environment after saving; never automatically delete saved results.
- Unit tests alone are enough for isolated internal changes they fully cover.
  Documentation-only and wording-only changes normally do not need real tests.
