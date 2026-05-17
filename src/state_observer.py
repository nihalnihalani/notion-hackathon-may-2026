"""Backwards-compatibility shim: dashboard sync lives in `src.dashboard_sync`.

This module is kept so existing imports of `src.state_observer` continue to
work. The canonical name per plan.md Task 8 is `src.dashboard_sync`.
"""

from src.dashboard_sync import (  # noqa: F401
    MAX_BLOCK_LEN,
    STATE_FILE,
    push_state_to_notion,
    safe_truncate_markdown,
    sync_dashboard,
)

def push_file_to_notion(client, block_id, file_name, hash_name, warroom_path, tail_only=False):
    """Upsert a generic file into a Notion code block. Idempotent on content hash."""
    if not block_id:
        return False
        
    file_path = os.path.join(warroom_path, file_name)
    if not os.path.exists(file_path):
        return False

    lock = FileLock(f"{file_path}.lock")
    with lock:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

    # If tail_only, grab the last ~1900 chars (useful for append-only logs like HANDOFFS)
    if tail_only and len(content) > 1900:
        content = "...[truncated]\n" + content[-1880:]

    current_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    hash_file = os.path.join(warroom_path, hash_name)
    
    if os.path.exists(hash_file):
        with open(hash_file, "r", encoding="utf-8") as f:
            if f.read().strip() == current_hash:
                return False

    safe_content = safe_truncate_markdown(content)

    rate_limit_sleep()
    client.update_block(
        block_id=block_id,
        code_payload={
            "rich_text": [{"type": "text", "text": {"content": safe_content}}],
            "language": "markdown",
        },
    )

    _atomic_write(hash_file, current_hash)
    return True
