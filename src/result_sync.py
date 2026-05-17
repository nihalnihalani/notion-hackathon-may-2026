"""Result sync: iterate Redis-backed handoffs and push status/result to Notion.

This is the Redis-backed rewrite of the result flow. Previously the bridge
parsed ``HANDOFFS.md`` from disk to discover changed handoffs and consulted
``StateStore`` for the Notion page mapping plus the per-page result hash.
The Redis migration replaces both pieces:

- ``RedisStore.list_handoffs`` yields every handoff hash (the authoritative
  copy — ``HANDOFFS.md`` is just a materialised view now).
- ``RedisStore.get_bridge_state`` returns the per-page mapping
  (``pages[page_id] -> {handoff_key, last_result_hash, ...}``) that used to
  live in the ``.notion_bridge_state.json`` sidecar.
- The single-block "result code block" tracking still lives in the bridge
  state JSON (under ``pages[page_id].last_result_block_id``) so the syncer
  continues to update one block in place per task rather than appending new
  ones.

Hash-based idempotency is preserved bit-for-bit: the same SHA-256 inputs
(``status + result + next_action``) and the same skip condition mean
unchanged handoffs still incur zero Notion API calls.
"""

from __future__ import annotations

import hashlib
import logging
import os
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from src.notion_http import NotionHTTPClient
from src.redis_store import RedisStore

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


# ---- Bridge state helpers (replace StateStore lookups) ---------------------


def _page_entry_for_key(state: Mapping[str, Any], handoff_key: str) -> Optional[dict]:
    """Find the bridge-state page entry matching a handoff key.

    Mirrors what ``StateStore.get_page_by_key`` returned: a copy of the
    page entry plus a synthesized ``page_id`` field. Returns None if no
    page in state references the given handoff key.
    """
    pages = state.get("pages") if isinstance(state, Mapping) else None
    if not isinstance(pages, Mapping):
        return None
    for page_id, entry in pages.items():
        if isinstance(entry, Mapping) and entry.get("handoff_key") == handoff_key:
            result = dict(entry)
            result["page_id"] = page_id
            return result
    return None


def _persist_result_sync(
    store: RedisStore,
    *,
    page_id: str,
    result_hash: str,
    last_local_status: str,
    last_notion_status: str,
    last_synced_at: str,
    last_result_block_id: Optional[str],
) -> None:
    """Atomically update one page entry inside the bridge state JSON blob.

    Replaces ``StateStore.mark_result_synced``. The caller must already
    hold ``store.locked()`` for the surrounding critical section.
    """
    state = store.get_bridge_state()
    pages = state.get("pages")
    if not isinstance(pages, dict):
        return
    entry = pages.get(page_id)
    if not isinstance(entry, Mapping):
        return
    new_entry = dict(entry)
    new_entry["last_result_hash"] = result_hash
    new_entry["last_local_status"] = last_local_status
    new_entry["last_notion_status"] = last_notion_status
    new_entry["last_synced_at"] = last_synced_at
    if last_result_block_id is not None:
        new_entry["last_result_block_id"] = last_result_block_id
    pages[page_id] = new_entry
    store.set_bridge_state(state)


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
    warroom_path: Optional[os.PathLike | str] = None,
    *,
    store: Optional[RedisStore] = None,
) -> int:
    """Push Redis-backed handoff status/result changes back to Notion.

    Returns the number of pages whose Notion record was updated this call.
    Unchanged entries (same content hash as last sync) skip the API entirely.

    ``warroom_path`` is accepted for backwards compatibility but is no
    longer consulted; all reads/writes flow through Redis via ``store``.
    """
    if store is None:
        store = RedisStore()

    handoffs = store.list_handoffs()
    if not handoffs:
        return 0

    pushed = 0
    state = store.get_bridge_state()

    for entry in handoffs:
        key = entry.get("_key")
        if not key:
            continue
        page = _page_entry_for_key(state, key)
        if page is None:
            log.debug("ignoring handoff %s with no state entry", key)
            continue
        page_id = page.get("page_id")
        if not page_id:
            continue

        raw_status = (entry.get("status") or "").strip().upper()
        notion_status = STATUS_MAP.get(raw_status)
        if notion_status is None:
            continue

        result_text = (entry.get("result") or "").strip()
        next_action = (entry.get("next_action") or "").strip()
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

        with store.locked():
            _persist_result_sync(
                store,
                page_id=page_id,
                result_hash=new_hash,
                last_local_status=raw_status,
                last_notion_status=notion_status,
                last_synced_at=when,
                last_result_block_id=new_block_id,
            )
            # Reflect the new sync timestamp back onto the handoff record so
            # any live dashboard render sees the latest activity without
            # waiting for a separate save.
            store.upsert_handoff(key, last_updated_at=when)
            # Refresh local snapshot of state for subsequent iterations in
            # this loop (so a multi-update cycle doesn't keep diffing against
            # stale page entries).
            state = store.get_bridge_state()

        pushed += 1

    return pushed
