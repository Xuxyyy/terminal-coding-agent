# Saving acc test transcripts

Use `scripts/export_acc_transcript.py` from this skill after each attempt.
It reads saved sessions without calling a model. It does not determine test
results or stop processes; the testing agent handles those steps.

The transcript is the actual acc conversation, in the benchmark transcript style:
user instruction, agent text, named tool calls with their arguments, tool results,
and the final reply. Render these recorded contents directly, not as a summary
of the tester's actions. Keep terminal observations and verification evidence
in separate files. A free UI-only check has no task conversation; do not present
its evidence archive as an example of a task transcript.

Before exiting acc, capture relevant terminal output and record any keys,
permission decisions, or timing needed to understand the test. Conversation
records alone do not capture all UI interactions. Save these observations in
temporary text files. Include only the input/output files needed as evidence.
Inspect records and evidence for credentials before saving; never archive .env
files, credential files, or the entire workspace. Redact sensitive values in a
temporary export copy when necessary and state that the archive was redacted.

Use ACC_REPO set to the checkout root by the test setup.
Stop the app so records are stable, then export:

```sh
python3 "$ACC_REPO/.agents/skills/tui-e2e/scripts/export_acc_transcript.py" --acc-home "$ACC_HOME" --label file-edit --evidence "$W/terminal.txt"
```

Choose a short label for the tested change. The `--evidence` option is optional
and repeatable; pass only existing files. The first export creates a unique
dated task folder under `~/.acc/e2e-runs/`. This path does not use ACC_HOME.
The command prints the task directory, attempt transcript, and task index.

For another scenario or retry in the same verification task, add
`--run-dir "$ACC_TEST_RUN_DIR"` using the directory returned by the first export.
Pass this directory and accumulated spend to subsequent subagent invocations.
Each export creates a new attempt; it does not replace earlier evidence.

```text
~/.acc/e2e-runs/<date>_<change>_<unique-id>/
  index.md                      Index of all attempts
  attempt-001/
    transcript.md               Instructions, replies, calls, and tool results
    evidence.md                 Links to separate verification evidence
    session-001/session.jsonl   Original records, including rewind history
    session-001/session.json    Session metadata and recorded usage
    evidence/                   Explicitly selected files and observations
```

Multiple sessions get separate session folders. Rewinds and compaction appear
as events; the transcript preserves test history rather than pretending it is
only the active conversation. Missing or unreadable records are stated. Free
checks without conversations can still save terminal evidence.

Verify the printed transcript paths and evidence files exist before deleting
the temporary workspace. On export failure, stop this run's processes, preserve
the unsaved workspace, and report its location. On interruption, the parent
should finish saving and cleanup when it regains control; do not sweep unrelated
temporary folders or active runs. Saved task folders have no automatic expiry.
The user can delete individual folders or clear `~/.acc/e2e-runs/` manually.
