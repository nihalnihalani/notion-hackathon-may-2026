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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional

from src.notion_http import NotionHTTPClient
from src.state_store import StateStore
from src.warroom_format import extract_bridge_key, parse_handoffs

log = logging.getLogger(__name__)


HANDOFFS_NAME = "HANDOFFS.md"
STATUS_MAP = {
    "PENDING": "Dispatched",
    "IN PROGRESS": "In Progress",
    "BLOCKED": "Blocked",
    "COMPLETED": "Completed",
    "FAILED": "Failed",
}
MAX_RICH_TEXT_LEN = 1900


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
