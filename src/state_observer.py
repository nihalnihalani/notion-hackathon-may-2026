"""Dashboard observer: mirror `CURRENT_STATE.md` to Notion.

Uses `NotionHTTPClient` and `StateStore` to safely truncate and sync
the War Room's current state to a single dashboard block in Notion.
"""

from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
from typing import Optional

from src.notion_http import NotionHTTPClient
from src.state_store import StateStore

log = logging.getLogger(__name__)

STATE_FILE = "CURRENT_STATE.md"
MAX_BLOCK_LEN = 1900


def safe_truncate_markdown(content: str, limit: int = MAX_BLOCK_LEN) -> str:
    """Truncate to Notion's block limit without breaking code fences."""
    if len(content) <= limit:
        return content
    truncated = content[:limit]
    if truncated.count("```") % 2 != 0:
        truncated += "\n```"
    return truncated + "\n...[truncated]"


def push_state_to_notion(
    client: NotionHTTPClient,
    dashboard_page_id: str,
    warroom_path: Path,
    store: StateStore,
) -> bool:
    """Upsert CURRENT_STATE.md into the dashboard. Idempotent on content hash."""
    state_path = warroom_path / STATE_FILE
    if not state_path.exists():
        return False

    with store.locked():
        with open(state_path, "r", encoding="utf-8") as f:
            content = f.read()

    current_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    if store.dashboard_hash == current_hash:
        return False

    safe_content = safe_truncate_markdown(content)
    block_id = store.dashboard_block_id

    # If no block exists yet, create one
    if not block_id:
        res = client.append_block_children(
            dashboard_page_id,
            [
                {
                    "object": "block",
                    "type": "code",
                    "code": {
                        "rich_text": [{"type": "text", "text": {"content": safe_content}}],
                        "language": "markdown",
                    },
                }
            ],
        )
        new_block = res.get("results", [])[0]
        block_id = new_block["id"]
        store.set_dashboard_block_id(block_id)
    else:
        # Update existing
        try:
            client.update_block(
                block_id=block_id,
                payload={
                    "code": {
                        "rich_text": [{"type": "text", "text": {"content": safe_content}}],
                        "language": "markdown",
                    }
                },
            )
        except Exception as e:
            log.warning(f"Failed to update block {block_id}, it might have been deleted. {e}")
            # If the block was deleted, we'd want to clear the ID and recreate next time.
            store.set_dashboard_block_id(None)
            return False

    store.set_dashboard_hash(current_hash)
    return True