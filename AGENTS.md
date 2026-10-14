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

- `DEEPSEEK_API_KEY` supplies the DeepSeek coding model. `GEMINI_API_KEY` supplies
  the Gemini permission judge. Preserve these roles and the current model setup.
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
