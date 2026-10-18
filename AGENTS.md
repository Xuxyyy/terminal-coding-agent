# Development priorities

- Prioritize ACC's ability to complete real tasks correctly and efficiently.
  Evaluate changes using task success rate, agent execution time, token usage,
  API cost, and consistency across repeated runs.
- Use evaluation evidence to choose improvements. Do not assume lower token
  usage or shorter execution time is an improvement when task success declines.
- Give interface polish lower priority unless it addresses a concrete usability
  problem. Preserve functional behavior such as cancellation, permissions, and
  recovery.
- Keep benchmark comparisons tied to recorded source versions and settings. Do
  not make task-specific changes solely to improve benchmark scores.
- Keep actual scores, run counts, budgets, and evaluation plans in separate
  records rather than in this file. These priorities do not authorize evaluation
  runs or paid API calls; follow the approval requirements below.

# Public repository safety

- This repository is public. Never put credentials, private transcripts, or
  genuinely private personal or machine information in tracked files.
- Demo screenshots the user confirms are intended for public display and
  ordinary example paths are allowed. A visible local username, project name,
  or file path alone must not block a commit or trigger Git history cleanup.
  Prefer placeholders in new examples where practical. Still inspect approved
  screenshots and examples for credentials and genuinely private information;
  approval to display a demo does not waive those checks.
- Before staging, committing, creating a pull request, or pushing, inspect all
  changed and staged files for secrets and sensitive local data. Check tracked
  files explicitly; do not rely on `.gitignore` alone. Never stage credential
  files. A sanitized `.env.example` may contain placeholders only.
- If credentials or genuinely private information may already be tracked or
  present in Git history, stop and warn the user without displaying it. Do not
  commit or push until resolved. Allowed public demos and ordinary example
  paths alone do not trigger this stop.

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

- When the user asks only to commit existing changes, do not rerun tests or
  trigger a testing subagent unless the user explicitly requests testing.
  Use existing verification results and report known gaps. Required secret and
  sensitive-data checks still apply.
- When implementing changes to the agent loop or its connected behavior,
  delegate a focused real test to `acc-e2e` after relevant unit checks pass and
  before reporting completion. Give it the change, expected behavior, and source
  locations. Unit tests suffice for isolated internal changes they fully cover;
  documentation-only and wording-only changes normally need no real tests.
- Obtain approval for paid tests under the API rules above. Pass the approved
  scope, accumulated spend, remaining budget, and any existing evidence folder
  to the subagent. Use `.codex/agents/acc-e2e.toml` for the spending limit and
  detailed test procedure; retries do not reset the budget.
- Fix failures caused by the change and rerun affected checks within the
  approved scope. Report failures, skipped or blocked checks, and verification
  limits, with a link to the saved transcript.
