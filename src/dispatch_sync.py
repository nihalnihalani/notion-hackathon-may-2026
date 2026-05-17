import json
import os
import tempfile
import time
from datetime import datetime, timezone
from filelock import FileLock

LEDGER_NAME = ".bridge_ledger.json"
HANDOFFS_NAME = "HANDOFFS.md"
ALLOWED_OWNERS = {"Hermes", "OpenClaw", "Codex", "User"}
NOTION_ID_MARKER_FMT = "<!-- ID: {task_id} -->"

def rate_limit_sleep():
    time.sleep(0.4)  # Safely below Notion's 3 req/sec cap.

def _ledger_path(warroom_path):
    return os.path.join(warroom_path, LEDGER_NAME)

def load_ledger(warroom_path):
    path = _ledger_path(warroom_path)
    if not os.path.exists(path):
        return {"dispatched_tasks": [], "completed_tasks": []}
    with open(path, "r") as f:
        data = json.load(f)
    data.setdefault("dispatched_tasks", [])
    data.setdefault("completed_tasks", [])
    return data

def save_ledger(warroom_path, ledger_data):
    """Atomic write: tempfile in the same dir, then os.replace."""
    path = _ledger_path(warroom_path)
    os.makedirs(warroom_path, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".bridge_ledger.", suffix=".tmp", dir=warroom_path)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(ledger_data, f, indent=2)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise

def sanitize_working_dir(requested_path, warroom_path):
    """Resolve under warroom_path; reject symlink escapes. Returns warroom_path on any violation."""
    warroom_real = os.path.realpath(warroom_path)
    if not requested_path:
        return warroom_real
    # Treat any leading slash as relative to the War Room root, never absolute.
    candidate = os.path.realpath(os.path.join(warroom_real, requested_path.lstrip("/")))
    if candidate == warroom_real or candidate.startswith(warroom_real + os.sep):
        return candidate
    return warroom_real

def _rich_text(prop):
    if not prop: return ""
    parts = prop.get("rich_text") or []
    return "".join(p.get("text", {}).get("content", "") for p in parts).strip()

def _title(prop):
    if not prop: return "Untitled"
    parts = prop.get("title") or []
    text = "".join(p.get("text", {}).get("content", "") for p in parts).strip()
    return text or "Untitled"

def _select(prop, default):
    if not prop: return default
    sel = prop.get("select")
    return (sel or {}).get("name") or default

def append_handoff_entry(task_id, title, assignee, context, files_touched, work_dir, next_action, warroom_path):
    """Append a PROTOCOL.md-compliant six-field handoff entry, plus a Notion-ID marker."""
    handoff_path = os.path.join(warroom_path, HANDOFFS_NAME)
    lock = FileLock(f"{handoff_path}.lock")
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    safe_dir = sanitize_working_dir(work_dir, warroom_path)
    owner = assignee if assignee in ALLOWED_OWNERS else "Hermes"
    safe_title = title.replace("\n", " ").strip()
    files_line = files_touched.strip() or "~/WarRoom/HANDOFFS.md only"
    next_line = next_action.strip() or "Execute task and append Result/Next Action when done."

    lines = [
        "",
        NOTION_ID_MARKER_FMT.format(task_id=task_id),
        f"- Task: {safe_title} (Notion {task_id}, dispatched {timestamp})",
        f"  Owner: {owner}",
        f"  Files Touched: {files_line}",
        "  Status: PENDING",
        f"  Result: (pending; Working Dir: {safe_dir}; Context: {context.strip()})",
        f"  Next Action: {next_line}",
        "",
    ]
    entry = "\n".join(lines)

    with lock:
        with open(handoff_path, "a") as f:
            f.write(entry)

def sync_dispatch(client, db_id, warroom_path):
    ledger = load_ledger(warroom_path)
    dispatched_set = set(ledger["dispatched_tasks"])
    has_more = True
    next_cursor = None
    processed = 0

    while has_more:
        rate_limit_sleep()
        kwargs = {
            "filter": {"property": "Status", "status": {"equals": "Pending"}},
            "page_size": 50,
        }
        if next_cursor:
            kwargs["start_cursor"] = next_cursor

        response = client.query_database(db_id, kwargs)
        for task in response.get("results", []):
            task_id = task["id"]
            if task_id in dispatched_set:
                continue

            props = task.get("properties", {})
            title = _title(props.get("Name"))
            assignee = _select(props.get("Assignee"), "Hermes")
            context = _rich_text(props.get("Context"))
            work_dir = _rich_text(props.get("Working Directory"))
            files_touched = _rich_text(props.get("Files Touched") or props.get("Authorized Files"))
            next_action = _rich_text(props.get("Next Action"))

            append_handoff_entry(
                task_id, title, assignee, context, files_touched, work_dir, next_action, warroom_path
            )

            rate_limit_sleep()
            client.update_page(
                page_id=task_id,
                properties={"Status": {"status": {"name": "Dispatched"}}},
            )
            dispatched_set.add(task_id)
            ledger["dispatched_tasks"] = sorted(dispatched_set)
            save_ledger(warroom_path, ledger)
            processed += 1

        has_more = response.get("has_more", False)
        next_cursor = response.get("next_cursor")

    return processed
