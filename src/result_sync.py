"""Result sync: parse `HANDOFFS.md` and push status/result back to Notion.

Reads the War Room handoff file under the bridge lock owned by
`StateStore`, looks up every `[wrb_*]` key against the persisted state, and
upserts the corresponding Notion page (properties + a single bridge-owned
result block). Hash-based idempotency keeps the daemon from spamming the
Notion API when handoffs are unchanged.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional

from src.notion_http import NotionHTTPClient
from src.state_store import StateStore

log = logging.getLogger(__name__)


HANDOFFS_NAME = "HANDOFFS.md"
KEY_RE = re.compile(r"\[(wrb_[0-9a-f]{12})\]")
FIELD_RE = re.compile(
    r"^\s*(?:-\s+)?(Task|Owner|Files Touched|Status|Result|Next Action)\s*:\s*(.*)$"
)
STATUS_MAP = {
    "PENDING": "Dispatched",
    "IN PROGRESS": "In Progress",
    "BLOCKED": "Blocked",
    "COMPLETED": "Completed",
    "FAILED": "Failed",
}
MAX_RICH_TEXT_LEN = 1900


# ---- Parsing ---------------------------------------------------------------


def extract_bridge_key(task_field: str) -> Optional[str]:
    if not task_field:
        return None
    m = KEY_RE.search(task_field)
    return m.group(1) if m else None


def parse_handoffs(text: str) -> Iterator[tuple[str, dict[str, str]]]:
    """Yield (handoff_key, fields) for each well-formed protocol block."""
    if not text:
        return
    blocks = re.split(r"\n\s*\n+", text)
    for block in blocks:
        if not block.strip():
            continue
        fields: dict[str, str] = {}
        last_key: Optional[str] = None
        for raw_line in block.splitlines():
            m = FIELD_RE.match(raw_line)
            if m:
                last_key = m.group(1)
                fields[last_key] = m.group(2).strip()
            elif last_key and raw_line.strip():
                fields[last_key] = (
                    fields[last_key] + "\n" + raw_line.strip()
                ).strip()
        if "Task" not in fields or "Owner" not in fields or "Status" not in fields:
            continue
        key = extract_bridge_key(fields["Task"])
        if not key:
            continue
        yield key, fields


# ---- Helpers ---------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sync_hash(*parts: str) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update((p or "").encode("utf-8"))
        h.update(b"\0")
    return h.hexdigest()


def _rich_text_prop(text: str) -> dict[str, Any]:
    if not text:
        return {"rich_text": []}
    return {
        "rich_text": [
            {"type": "text", "text": {"content": text[:MAX_RICH_TEXT_LEN]}}
        ]
    }


def _truncate(text: str) -> str:
    return (text or "")[:MAX_RICH_TEXT_LEN]


def _format_result_block_text(status: str, result: str, next_action: str) -> str:
    lines = [
        f"Status: {status}",
        f"Result: {result or '(none)'}",
        f"Next Action: {next_action or '(none)'}",
    ]
    return "\n".join(lines)[:MAX_RICH_TEXT_LEN]


def _result_block_payload(status: str, result: str, next_action: str) -> dict[str, Any]:
    return {
        "code": {
            "rich_text": [
                {
                    "type": "text",
                    "text": {
                        "content": _format_result_block_text(
                            status, result, next_action
                        )
                    },
                }
            ],
            "language": "markdown",
        }
    }


def _build_properties(
    notion_status: str,
    result_text: str,
    next_action: str,
    when: str,
    sync_hash: str,
) -> dict[str, Any]:
    return {
        "Status": {"status": {"name": notion_status}},
        "Result Summary": _rich_text_prop(_truncate(result_text)),
        "Next Action": _rich_text_prop(_truncate(next_action)),
        "Last Synced At": {"date": {"start": when}},
        "Last Sync Hash": {
            "rich_text": [{"type": "text", "text": {"content": sync_hash}}]
        },
    }


def _read_handoffs(store: StateStore, warroom: Path) -> str:
    path = warroom / HANDOFFS_NAME
    if not path.exists():
        return ""
    with store.locked():
        return path.read_text(encoding="utf-8")


def _upsert_result_block(
    client: NotionHTTPClient,
    page_id: str,
    existing_block_id: Optional[str],
    block_payload: Mapping[str, Any],
) -> Optional[str]:
    """Update an existing bridge-owned result block, or append a fresh one."""
    if existing_block_id:
        try:
            client.update_block(existing_block_id, block_payload)
            return existing_block_id
        except Exception:
            log.exception(
                "could not update result block %s on page %s; creating a new one",
                existing_block_id,
                page_id,
            )
    child = {"object": "block", "type": "code", **block_payload}
    response = client.append_block_children(page_id, [child])
    results = response.get("results") or []
    if results:
        first = results[0]
        if isinstance(first, Mapping):
            new_id = first.get("id")
            if isinstance(new_id, str):
                return new_id
    return existing_block_id


# ---- Public entry point ----------------------------------------------------


def sync_results(
    client: NotionHTTPClient,
    warroom_path: os.PathLike | str,
    *,
    store: Optional[StateStore] = None,
) -> int:
    """Push HANDOFFS.md status/result changes back to Notion.

    Returns the number of pages whose Notion record was updated this call.
    Unchanged entries (same content hash as last sync) skip the API entirely.
    """
    warroom = Path(warroom_path)
    if store is None:
        store = StateStore(warroom)

    text = _read_handoffs(store, warroom)
    if not text:
        return 0

    pushed = 0
    for key, fields in parse_handoffs(text):
        page = store.get_page_by_key(key)
        if page is None:
            log.debug("ignoring handoff %s with no state entry", key)
            continue
        page_id = page.get("page_id")
        if not page_id:
            continue

        raw_status = (fields.get("Status") or "").strip().upper()
        notion_status = STATUS_MAP.get(raw_status)
        if notion_status is None:
            continue

        result_text = (fields.get("Result") or "").strip()
        next_action = (fields.get("Next Action") or "").strip()
        new_hash = _sync_hash(raw_status, result_text, next_action)

        if new_hash == page.get("last_result_hash"):
            continue

        when = _now_iso()
        properties = _build_properties(
            notion_status, result_text, next_action, when, new_hash
        )
        client.update_page(page_id, properties)

        block_payload = _result_block_payload(raw_status, result_text, next_action)
        new_block_id = _upsert_result_block(
            client,
            page_id,
            page.get("last_result_block_id"),
            block_payload,
        )

        store.mark_result_synced(
            key,
            new_hash,
            last_local_status=raw_status,
            last_notion_status=notion_status,
            last_synced_at=when,
            last_result_block_id=new_block_id,
        )
        pushed += 1

    return pushed
