import json
from pathlib import Path
import shutil
import tempfile
import unittest

from export_acc_transcript import export_run, render_records


class TranscriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "workspace" / ".acc-home"
        self.session = self.home / "projects" / "demo-123" / "sessions" / "one"
        self.session.mkdir(parents=True)
        self.output = self.root / "saved"

    def record(self, records):
        (self.session / "session.jsonl").write_text("\n".join(json.dumps(r) for r in records) + "\n")

    def test_archives_conversation_and_evidence_before_workspace_cleanup(self):
        self.record([
            {"kind": "message", "message": {"role": "user", "content": "Change value to 2"}},
            {"kind": "messages", "messages": [
                {"role": "assistant", "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "edit_file", "arguments": "{\"path\":\"value.txt\"}"}}]},
                {"role": "tool", "tool_call_id": "call-1", "content": "Updated value.txt"},
                {"role": "assistant", "content": "Done"},
            ]},
        ])
        (self.session / "session.json").write_text('{"status":"closed"}')
        (self.home / "settings.json").write_text('{"model":"test-only"}')
        evidence = self.home.parent / "terminal.txt"
        evidence.write_text("approval accepted")
        result = export_run(self.home, self.output, evidence=[evidence])
        shutil.rmtree(self.home.parent)
        text = Path(result["transcript"]).read_text()
        for value in ["Change value to 2", "edit\\_file", "Updated value.txt", "Done"]:
            self.assertIn(value, text)
        attempt = Path(result["transcript"]).parent
        self.assertEqual((attempt / "evidence/001-terminal.txt").read_text(), "approval accepted")
        self.assertTrue((attempt / "session-001/session.jsonl").exists())
        self.assertTrue((attempt / "session-001/session.json").exists())
        self.assertFalse(list(self.output.rglob("settings.json")))
        self.assertTrue((attempt / "evidence.md").exists())
        self.assertNotIn("approval accepted", text)

    def test_readable_task_calls_results_and_reply_in_order(self):
        records = [
            {"kind": "message", "message": {"role": "user", "content": "Read notes.txt and tell me the second line."}},
            {"kind": "messages", "messages": [
                {"role": "assistant", "content": "I will read the file.", "tool_calls": [{"id": "read-1", "function": {"name": "bash", "arguments": '{"command":"cat notes.txt"}'}}]},
                {"role": "tool", "tool_call_id": "read-1", "content": "alpha\nbeta\ngamma\n[exit 0]"},
                {"role": "assistant", "content": "The second line is **beta**."},
            ]},
        ]
        text = render_records("\n".join(json.dumps(r) for r in records))
        items = ["## User instruction", "Read notes.txt", "## Agent", "I will read the file.", "**bash** · `cat notes.txt`", "**Result · bash**", "alpha\nbeta\ngamma", "## Final reply", "The second line is **beta**."]
        positions = [text.index(item) for item in items]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn('"tool_call_id"', text)
        self.assertNotIn('"function"', text)

    def test_tool_failure_does_not_invent_final_reply(self):
        records = [{"kind": "messages", "messages": [
            {"role": "assistant", "tool_calls": [{"id": "bad-1", "function": {"name": "bash", "arguments": '{"command":"missing-command"}'}}]},
            {"role": "tool", "tool_call_id": "bad-1", "content": "command not found\n[exit 127]"},
        ]}]
        text = render_records(json.dumps(records[0]))
        self.assertIn("command not found\n[exit 127]", text)
        self.assertNotIn("## Final reply", text)

    def test_retry_preserves_first_attempt(self):
        self.record([{"kind": "message", "message": {"role": "user", "content": "first"}}])
        first = export_run(self.home, self.output)
        original = Path(first["transcript"]).read_bytes()
        self.record([{"kind": "message", "message": {"role": "user", "content": "retry"}}])
        second = export_run(self.home, self.output)
        self.assertNotEqual(first["transcript"], second["transcript"])
        self.assertEqual(Path(first["transcript"]).read_bytes(), original)
        index = Path(second["index"]).read_text()
        self.assertIn("attempt-001", index)
        self.assertIn("attempt-002", index)

    def test_missing_and_incomplete_records_are_visible(self):
        result = export_run(self.home, self.output)
        self.assertIn("No session records", Path(result["transcript"]).read_text())
        text = render_records('{"kind":"message"\n')
        self.assertIn("Unreadable record", text)
        self.assertIn("incomplete", text)

    def test_rewind_keeps_audit_history_without_repeating_views(self):
        records = [
            {"kind": "message", "message": {"role": "user", "content": "original task"}},
            {"kind": "view", "items": [{"kind": "task", "text": "original task"}]},
            {"kind": "rewind", "to": 0},
            {"kind": "compact", "summary": "compact summary"},
        ]
        text = render_records("\n".join(json.dumps(r) for r in records))
        self.assertEqual(text.count("original task"), 1)
        self.assertIn("Rewind", text)
        self.assertIn("compact summary", text)

    def test_markdown_fences_in_content_are_preserved(self):
        text = render_records(json.dumps({"kind": "message", "message": {"role": "user", "content": "```\n# heading\n```"}}))
        self.assertIn("````text\n```\n# heading\n```\n````", text)

    def test_rejects_output_inside_temporary_state_and_env_evidence(self):
        with self.assertRaises(ValueError):
            export_run(self.home, self.home / "results")
        env = self.root / ".env"
        env.write_text("EXAMPLE=placeholder")
        with self.assertRaises(ValueError):
            export_run(self.home, self.output, evidence=[env])
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
