import logging
import os
import hashlib
from typing import Optional

from src.notion_http import NotionHTTPClient
from src.state_store import StateStore

logger = logging.getLogger(__name__)

def safe_truncate_markdown(content: str, limit: int = 1900) -> str:
    """Truncate content to fit inside Notion's 2000-character block limit."""
    if len(content) <= limit:
        return content
    truncated = content[:limit]
    if truncated.count("```") % 2 != 0:
        truncated += "\n```"
    return truncated + "\n...[truncated]"

def sync_dashboard(
    client: NotionHTTPClient,
    state_store: StateStore,
    warroom_path: str,
    block_id: Optional[str] = None
) -> bool:
    """Read local CURRENT_STATE.md and upsert it into the Notion dashboard block."""
    with state_store.locked():
        state = state_store.load()
        # Fall back to state store if block_id wasn't passed directly
        if block_id is None:
            block_id = state.get("dashboard_block_id")

        if not block_id:
            logger.debug("No dashboard block ID found. Skipping dashboard sync.")
            return False

        state_path = os.path.join(warroom_path, "CURRENT_STATE.md")
        if not os.path.exists(state_path):
            return False
            
        try:
            with open(state_path, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception as e:
            logger.error(f"Failed to read CURRENT_STATE.md: {e}")
            return False

        current_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        last_hash = state.get("dashboard_hash")

        if last_hash == current_hash:
            return False

        safe_content = safe_truncate_markdown(content)
        
        try:
            client.update_block(
                block_id=block_id,
                code_payload={
                    "rich_text": [{"type": "text", "text": {"content": safe_content}}],
                    "language": "markdown",
                }
            )
            state["dashboard_hash"] = current_hash
            state_store.save(state)
            return True
        except Exception as e:
            logger.error(f"Failed to update dashboard block in Notion: {e}")
            return False
