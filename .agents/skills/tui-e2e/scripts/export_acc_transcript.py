import argparse
from datetime import datetime
import json
from pathlib import Path
import re
import tempfile
from zoneinfo import ZoneInfo


def block(value):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
    fence = "`" * max(3, 1 + max((len(x) for x in re.findall(r"`+", text)), default=0))
    return f"{fence}text\n{text}\n{fence}"


def inline(text):
    text = " ↵ ".join(str(text).splitlines())
    fence = "`" * (1 + max((len(x) for x in re.findall(r"`+", text)), default=0))
    return f"{fence} {text} {fence}" if "`" in text else f"{fence}{text}{fence}"


def tool_name(name):
    return re.sub(r"([\\`*_{}\[\]()#+.!<>|])", r"\\\1", " ".join(str(name).splitlines()))


def render_message(message, tools):
    if not isinstance(message, dict):
        return ["### Unreadable message", block(message)]
    role = message.get("role")
    if role == "system":
        return []
    content = message.get("content")
    calls = message.get("tool_calls") or []
    if role == "user":
        return ["## User instruction", block(content)]
    if role == "tool":
        name = tools.get(message.get("tool_call_id"), "unknown tool")
        return [f"**Result · {tool_name(name)}**", block(content)]
    if role != "assistant":
        return ["## Message", block(message)]
    if not content and not calls:
        return []
    parts = ["## Agent" if calls else "## Final reply"]
    if content:
        parts.append(content if isinstance(content, str) else block(content))
    for call in calls:
        function = call.get("function", {})
        name = function.get("name", "unknown tool")
        tools[call.get("id")] = name
        arguments = function.get("arguments", "")
        try:
            arguments = json.loads(arguments)
        except (json.JSONDecodeError, TypeError):
            pass
        if name == "bash" and isinstance(arguments, dict) and isinstance(arguments.get("command"), str):
            body = inline(arguments["command"])
            other = {key: value for key, value in arguments.items() if key not in {"command", "description"}}
            if other:
                body += " · " + inline(json.dumps(other, ensure_ascii=False))
        else:
            body = inline(json.dumps(arguments, ensure_ascii=False))
        parts.extend([f"**{tool_name(name)}** · {body}", "---"])
    return parts


def render_records(text):
    parts = []
    tools = {}
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            record = None
        if not isinstance(record, dict):
            parts.extend([f"### Unreadable record at line {number}", "The saved transcript may be incomplete.", block(line)])
            continue
        kind = record.get("kind")
        if kind == "message":
            parts.extend(render_message(record.get("message"), tools))
        elif kind == "messages":
            for message in record.get("messages", []):
                parts.extend(render_message(message, tools))
        elif kind == "rewind":
            parts.extend(["### Rewind", "Earlier events remain above as test history; they may no longer be in the active conversation.", block(record)])
        elif kind == "compact":
            parts.extend(["### Compaction", block(record.get("summary", "No summary recorded."))])
        elif kind not in {"view", "code"}:
            parts.extend(["### Other record", block(record)])
    return "\n\n".join(parts) or "No conversation messages were recorded."


def save(path, data):
    with path.open("xb") as stream:
        path.chmod(0o600)
        stream.write(data)


def export_run(acc_home, run_dir=None, label="verification", evidence=()):
    acc_home = Path(acc_home).resolve()
    if not acc_home.is_dir():
        raise ValueError("ACC_HOME must be an existing directory")
    evidence = [Path(path) for path in evidence]
    if any(not path.is_file() or path.is_symlink() for path in evidence):
        raise ValueError("Evidence must be explicit regular files, not symlinks")
    if any(path.name.startswith(".env") for path in evidence):
        raise ValueError("Do not archive environment files")
    if run_dir is None:
        root = Path.home() / ".acc" / "e2e-runs"
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        label = re.sub(r"[^a-zA-Z0-9_-]+", "-", label).strip("-")[:60] or "verification"
        stamp = datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d_%H%M%S")
        run_dir = Path(tempfile.mkdtemp(prefix=f"{stamp}_{label}_", dir=root))
    else:
        run_dir = Path(run_dir).expanduser().resolve()
        if run_dir == acc_home or acc_home in run_dir.parents:
            raise ValueError("Save results outside ACC_HOME so cleanup cannot remove them")
        run_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    number = 1
    while True:
        attempt = run_dir / f"attempt-{number:03d}"
        try:
            attempt.mkdir(mode=0o700)
            break
        except FileExistsError:
            number += 1
    parts = ["# ACC transcript"]
    links = []
    sessions = sorted({p.parent for name in ("session.jsonl", "session.json") for p in acc_home.glob(f"projects/*/sessions/*/{name}")})
    for index, session in enumerate(sessions, 1):
        destination = attempt / f"session-{index:03d}"
        destination.mkdir(mode=0o700)
        if len(sessions) > 1:
            parts.append(f"## Session {index}")
        for name in ("session.jsonl", "session.json"):
            source = session / name
            if source.is_file() and not source.is_symlink():
                data = source.read_bytes()
                save(destination / name, data)
                links.append(f"[Session {index}: {name}](session-{index:03d}/{name})")
                if name == "session.jsonl":
                    parts.append(render_records(data.decode("utf-8", errors="replace")))
            elif name == "session.jsonl":
                parts.append("No conversation records were saved for this session.")
    if not sessions:
        parts.append("No session records were found. A free UI check or an early failure may not create a conversation.")
    if evidence:
        folder = attempt / "evidence"
        folder.mkdir(mode=0o700)
        evidence_links = ["# Test evidence"]
        for index, source in enumerate(evidence, 1):
            name = f"{index:03d}-" + (re.sub(r"[^a-zA-Z0-9_.-]", "-", source.name) or "evidence")
            save(folder / name, source.read_bytes())
            evidence_links.append(f"[{name}](evidence/{name})")
        save(attempt / "evidence.md", ("\n\n".join(evidence_links) + "\n").encode())
        links.append("[Test evidence](evidence.md)")
    if links:
        parts.append("Original records and evidence: " + " · ".join(links))
    save(attempt / "transcript.md", ("\n\n".join(parts) + "\n").encode())
    entries = sorted(run_dir.glob("attempt-*/transcript.md"))
    index_text = "# ACC E2E transcripts\n\n" + "\n".join(f"- [{p.parent.name}]({p.parent.name}/transcript.md)" for p in entries) + "\n"
    with tempfile.NamedTemporaryFile(dir=run_dir, delete=False) as stream:
        stream.write(index_text.encode())
        temporary = Path(stream.name)
    temporary.replace(run_dir / "index.md")
    return {"run_dir": str(run_dir), "transcript": str(attempt / "transcript.md"), "index": str(run_dir / "index.md")}


def main():
    parser = argparse.ArgumentParser(description="Save ACC E2E transcripts without model calls or deleting test data.")
    parser.add_argument("--acc-home", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--label", default="verification")
    parser.add_argument("--evidence", type=Path, action="append", default=[])
    args = parser.parse_args()
    print(json.dumps(export_run(args.acc_home, args.run_dir, args.label, args.evidence), indent=2))


if __name__ == "__main__":
    main()
