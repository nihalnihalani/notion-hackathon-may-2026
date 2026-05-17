"""Dashboard observer: mirror Redis-backed `CURRENT_STATE.md` to one Notion code block.

Per plan.md section 6.C the bridge owns exactly one code block under
`NOTION_DASHBOARD_PAGE_ID`. After the Redis migration the source content
lives at ``wr:file:CURRENT_STATE.md`` (via ``RedisStore.get_file``) rather
than on disk; the dashboard block id and the last-pushed content hash both
live inside the bridge-state JSON blob returned by
``RedisStore.get_bridge_state``:

- If no block id exists, append exactly one new code block and store its id.
- If a block id exists, update that block in place.
- If the stored block was deleted (Notion 404), forget the id so the next
  cycle recreates exactly one block — never append endless dashboard blocks.

Content is SHA-256 hashed; unchanged content skips the Notion API entirely.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Any, Optional

from src.notion_http import NotionAPIError, NotionHTTPClient
from src.redis_store import RedisStore

log = logging.getLogger(__name__)


STATE_FILE = "CURRENT_STATE.md"
MAX_BLOCK_LEN = 1900


def safe_truncate_markdown(content: str, limit: int = MAX_BLOCK_LEN) -> str:
    """Truncate to Notion's 2000-char block limit without breaking code fences."""
    if len(content) <= limit:
        return content
    truncated = content[:limit]
    if truncated.count("```") % 2 != 0:
        truncated += "\n```"
    return truncated + "\n...[truncated]"


def _code_block_payload(text: str) -> dict:
    return {
        "code": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "language": "markdown",
        }
    }


# ---- Bridge-state helpers (replace StateStore property API) ----------------


def _get_dashboard_block_id(state: dict) -> Optional[str]:
    block_id = state.get("dashboard_block_id")
    return block_id if isinstance(block_id, str) and block_id else None


def _get_dashboard_hash(state: dict) -> Optional[str]:
    dash_hash = state.get("dashboard_hash")
    return dash_hash if isinstance(dash_hash, str) and dash_hash else None


def _persist_dashboard(
    store: RedisStore,
    *,
    block_id: Optional[Any] = ...,
    dashboard_hash: Optional[Any] = ...,
) -> None:
    """Update the dashboard fields inside the bridge state JSON blob.

    Uses sentinel defaults so callers can update one field independently
    of the other, matching the old ``set_dashboard_block_id`` /
    ``set_dashboard_hash`` split. The caller must already hold
    ``store.locked()`` for the surrounding critical section.
    """
    state = store.get_bridge_state()
    if block_id is not ...:
        state["dashboard_block_id"] = block_id
    if dashboard_hash is not ...:
        state["dashboard_hash"] = dashboard_hash
    store.set_bridge_state(state)


def push_state_to_notion(
    client: NotionHTTPClient,
    dashboard_page_id: str,
    store: RedisStore,
    warroom_path: Optional[Path | str] = None,
) -> bool:
    """Upsert CURRENT_STATE.md into a single Notion dashboard block.

    Returns True if the Notion API was called (block created or updated),
    False if there was nothing to do (file missing in Redis, content
    unchanged, or the dashboard page id is empty).

    ``warroom_path`` is kept as an optional positional for back-compat;
    all reads flow through Redis via ``store``.
    """
    if not dashboard_page_id:
        log.debug("no dashboard page id configured; skipping dashboard sync")
        return False

    with store.locked():
        content = store.get_file(STATE_FILE)
    if content is None:
        return False

    current_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    state = store.get_bridge_state()
    if _get_dashboard_hash(state) == current_hash:
        return False

    safe_content = safe_truncate_markdown(content)
    payload = _code_block_payload(safe_content)
    block_id = _get_dashboard_block_id(state)

    if block_id:
        try:
            client.update_block(block_id, payload)
        except NotionAPIError as exc:
            if exc.status_code == 404:
                log.warning(
                    "dashboard block %s missing in Notion; recreating once",
                    block_id,
                )
                with store.locked():
                    _persist_dashboard(store, block_id=None)
                block_id = None
            else:
                log.exception(
                    "could not update dashboard block %s in Notion", block_id
                )
                return False
        except Exception:
            log.exception("unexpected error updating dashboard block; will retry")
            with store.locked():
                _persist_dashboard(store, block_id=None)
            return False

    if not block_id:
        child = {"object": "block", "type": "code", **payload}
        response = client.append_block_children(dashboard_page_id, [child])
        results = response.get("results") or []
        if not results:
            log.error("Notion returned no results when creating dashboard block")
            return False
        new_block = results[0]
        new_id = new_block.get("id") if isinstance(new_block, dict) else None
        if not new_id:
            log.error("Notion dashboard create response missing id: %r", new_block)
            return False
        with store.locked():
            _persist_dashboard(store, block_id=new_id)

    with store.locked():
        _persist_dashboard(store, dashboard_hash=current_hash)
    return True


# Plan canonical name; `push_state_to_notion` remains the call-site name.
sync_dashboard = push_state_to_notion
