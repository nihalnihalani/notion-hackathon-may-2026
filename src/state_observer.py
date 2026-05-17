import hashlib
import os
import tempfile
from filelock import FileLock

from src.dispatch_sync import rate_limit_sleep

STATE_FILE = "CURRENT_STATE.md"
HASH_FILE = ".state_hash"

def safe_truncate_markdown(content, limit=1900):
    """Truncate to ~Notion's 2000-char block limit without breaking code fences."""
    if len(content) <= limit:
        return content
    truncated = content[:limit]
    if truncated.count("```") % 2 != 0:
        truncated += "\n```"
    return truncated + "\n...[truncated]"

def _atomic_write(path, text):
    dir_ = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".state_hash.", suffix=".tmp", dir=dir_)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise

def push_state_to_notion(client, block_id, warroom_path):
    """Upsert CURRENT_STATE.md into the pre-created dashboard code block. Idempotent on content hash."""
    state_path = os.path.join(warroom_path, STATE_FILE)
    if not os.path.exists(state_path):
        return False

    lock = FileLock(f"{state_path}.lock")
    with lock:
        with open(state_path, "r") as f:
            content = f.read()

    current_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    hash_file = os.path.join(warroom_path, HASH_FILE)
    if os.path.exists(hash_file):
        with open(hash_file, "r") as f:
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
