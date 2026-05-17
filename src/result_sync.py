import os
import re
from filelock import FileLock

from src.dispatch_sync import (
    HANDOFFS_NAME,
    NOTION_ID_MARKER_FMT,
    load_ledger,
    rate_limit_sleep,
    save_ledger,
)

# Marker parsing pattern
MARKER_RE = re.compile(r"<!-- ID:\s*([a-zA-Z0-9-]+)\s*-->")
FIELD_RE = re.compile(r"^\s*-?\s*(Task|Owner|Files Touched|Status|Result|Next Action)\s*:\s*(.*)$")
TRUNCATE = 1900

def _read_handoffs(warroom_path):
    path = os.path.join(warroom_path, HANDOFFS_NAME)
    if not os.path.exists(path):
        return ""
    lock = FileLock(f"{path}.lock")
    with lock:
        with open(path, "r") as f:
            return f.read()

def _parse_entries(text):
    """Yield (task_id, fields_dict) for each marker found in text."""
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        m = MARKER_RE.search(lines[i])
        if not m:
            i += 1
            continue
        task_id = m.group(1)
        fields = {}
        last_key = None
        j = i + 1
        while j < len(lines):
            line = lines[j]
            if MARKER_RE.search(line):
                break
            if not line.strip():
                if fields:
                    break
                j += 1
                continue
            fm = FIELD_RE.match(line)
            if fm:
                last_key = fm.group(1)
                fields[last_key] = fm.group(2).strip()
            elif last_key:
                fields[last_key] = (fields[last_key] + " " + line.strip()).strip()
            j += 1
        yield task_id, fields
        i = j

def sync_results(client, warroom_path):
    ledger = load_ledger(warroom_path)
    completed_set = set(ledger.get("completed_tasks", []))
    dispatched_set = set(ledger.get("dispatched_tasks", []))
    text = _read_handoffs(warroom_path)
    if not text:
        return 0

    pushed = 0
    for task_id, fields in _parse_entries(text):
        if task_id in completed_set:
            continue
        if task_id not in dispatched_set:
            continue
        status = (fields.get("Status") or "").upper()
        if status != "COMPLETED":
            continue

        result_text = (fields.get("Result") or "")[:TRUNCATE]
        next_action = (fields.get("Next Action") or "")[:TRUNCATE]

        rate_limit_sleep()
        client.update_page(
            page_id=task_id,
            properties={
                "Status": {"status": {"name": "Completed"}},
                "Result": {"rich_text": [{"text": {"content": result_text}}]} if result_text else {"rich_text": []},
                "Next Action": {"rich_text": [{"text": {"content": next_action}}]} if next_action else {"rich_text": []},
            },
        )
        completed_set.add(task_id)
        ledger["completed_tasks"] = sorted(completed_set)
        save_ledger(warroom_path, ledger)
        pushed += 1

    return pushed
