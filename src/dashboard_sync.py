"""Dashboard observer: mirror `CURRENT_STATE.md` to a single Notion code block.

Per plan.md section 6.C the bridge owns exactly one code block under
`NOTION_DASHBOARD_PAGE_ID`. The block id is persisted in
`.notion_bridge_state.json` via the `StateStore` property API:

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

from src.notion_http import NotionAPIError, NotionHTTPClient
from src.state_store import StateStore

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


def push_state_to_notion(
    client: NotionHTTPClient,
    dashboard_page_id: str,
    warroom_path: Path | str,
    store: StateStore,
) -> bool:
    """Upsert CURRENT_STATE.md into a single Notion dashboard block.

    Returns True if the Notion API was called (block created or updated),
    False if there was nothing to do (file missing, content unchanged, or
    the dashboard page id is empty).
    """
    if not dashboard_page_id:
        log.debug("no dashboard page id configured; skipping dashboard sync")
        return False

    warroom = Path(warroom_path)
    state_path = warroom / STATE_FILE
    if not state_path.exists():
        return False

    with store.locked():
        content = state_path.read_text(encoding="utf-8")

    current_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    if store.dashboard_hash == current_hash:
        return False

    safe_content = safe_truncate_markdown(content)
    payload = _code_block_payload(safe_content)
    block_id = store.dashboard_block_id

    if block_id:
        try:
            client.update_block(block_id, payload)
        except NotionAPIError as exc:
            if exc.status_code == 404:
                log.warning(
                    "dashboard block %s missing in Notion; recreating once",
                    block_id,
                )
                store.set_dashboard_block_id(None)
                block_id = None
            else:
                log.exception(
                    "could not update dashboard block %s in Notion", block_id
                )
                return False
        except Exception:
            log.exception("unexpected error updating dashboard block; will retry")
            store.set_dashboard_block_id(None)
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
        store.set_dashboard_block_id(new_id)

    store.set_dashboard_hash(current_hash)
    return True


# Plan canonical name; `push_state_to_notion` remains the call-site name.
sync_dashboard = push_state_to_notion
