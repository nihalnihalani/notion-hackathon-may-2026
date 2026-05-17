"""Knowledge Base sync: mirror Redis-backed KB docs as Notion child pages.

For each markdown document registered in Redis (``RedisStore.list_kb_docs``),
the bridge maintains a single Notion child page under ``parent_page_id``.
The mapping is persisted inside the bridge-state JSON blob under
``kb_pages``:

```json
{
  "kb_pages": {
    "<section_key>": {"page_id": "<notion-page-id>", "hash": "sha256..."}
  }
}
```

Pattern (matching `dashboard_sync` / `mission_control_sync`):

- Section key: SHA-1 of the doc's stored relative path (stable, transport-
  agnostic) — same shape as the file-based version so existing Notion
  pages keep matching after the storage swap.
- First sync: ``client.create_page(parent_page_id, title, children=blocks)``
  and persist ``{page_id, hash}``.
- Unchanged content: skip; zero API calls.
- Content changed: append a single fresh "Updated <iso>" code block via
  ``client.append_block_children`` and refresh the stored hash. The original
  page is never recreated.
- 404 on append: forget the page id so the next sync recreates the page.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from src.markdown_to_notion import chunk_blocks, markdown_to_blocks
from src.notion_http import NotionAPIError, NotionHTTPClient
from src.redis_store import RedisStore

log = logging.getLogger(__name__)


# Notion limits a single create-page or children-append request to 100
# children. We keep slightly below that to be safe across SDK changes.
MAX_CHILDREN_PER_REQUEST = 100


def _section_key(rel_path: str) -> str:
    """Stable, hash-based section key for a relative doc path."""
    digest = hashlib.sha1(rel_path.encode("utf-8")).hexdigest()
    return digest[:16]


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _derive_title(content: str, fallback: str) -> str:
    """First non-empty line wins; strip leading `#`s. Falls back to file stem."""
    for raw in content.splitlines():
        line = raw.strip()
        if not line:
            continue
        # Strip up to 6 leading `#` chars for an H1/H2/... title.
        i = 0
        while i < len(line) and i < 6 and line[i] == "#":
            i += 1
        candidate = line[i:].strip()
        if candidate:
            return candidate[:200]
        return line[:200]
    return fallback or "Untitled"


def _fallback_from_rel(rel_path: str) -> str:
    """Filesystem-stem analogue for a Redis-stored relative path."""
    if not rel_path:
        return "Untitled"
    base = rel_path.rsplit("/", 1)[-1]
    return base[: -3] if base.endswith(".md") else base


def _update_marker_block(iso_timestamp: str, content: str) -> list[dict]:
    """A heading + a code block. Appended on each content change."""
    heading = {
        "object": "block",
        "type": "heading_3",
        "heading_3": {
            "rich_text": [
                {
                    "type": "text",
                    "text": {"content": f"Updated {iso_timestamp}"},
                }
            ]
        },
    }
    blocks = markdown_to_blocks(content)
    return [heading, *blocks]


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- Bridge-state helpers --------------------------------------------------


def _get_section_page(
    state: Mapping[str, Any], top_level: str, section_key: str
) -> Optional[dict]:
    bucket = state.get(top_level) if isinstance(state, Mapping) else None
    if not isinstance(bucket, Mapping):
        return None
    entry = bucket.get(section_key)
    return dict(entry) if isinstance(entry, Mapping) else None


def _set_section_page(
    store: RedisStore,
    top_level: str,
    section_key: str,
    page_id: Optional[str],
    content_hash: Optional[str],
) -> None:
    """Persist (or clear) a ``{page_id, hash}`` entry under ``top_level``.

    Replaces ``StateStore.set_kb_page`` / ``set_skill_page``. Holds
    ``store.locked()`` for the duration of the read-modify-write so two
    concurrent sync cycles can't trample each other.
    """
    if not section_key:
        raise ValueError("section_key is required")
    with store.locked():
        state = store.get_bridge_state()
        bucket = state.get(top_level)
        if not isinstance(bucket, dict):
            bucket = {}
            state[top_level] = bucket
        if page_id is None:
            bucket.pop(section_key, None)
        else:
            bucket[section_key] = {"page_id": page_id, "hash": content_hash}
        store.set_bridge_state(state)


def _sync_one_doc(
    client: NotionHTTPClient,
    parent_page_id: str,
    rel_path: str,
    content: str,
    store: RedisStore,
    *,
    top_level: str,
    iso_now,
) -> int:
    """Sync one Redis-backed doc to its Notion mirror page. Returns 1 on API call."""
    key = _section_key(rel_path)
    current_hash = _content_hash(content)
    entry = _get_section_page(store.get_bridge_state(), top_level, key)
    page_id = entry.get("page_id") if isinstance(entry, dict) else None
    stored_hash = entry.get("hash") if isinstance(entry, dict) else None

    if page_id and stored_hash == current_hash:
        return 0

    # First sync (or recreated after a 404): create the page with the body.
    if not page_id:
        title = _derive_title(content, fallback=_fallback_from_rel(rel_path))
        initial_blocks = markdown_to_blocks(content)
        # Stay under Notion's 100-children-per-request limit by sending only
        # the first chunk in create_page, then appending the rest.
        chunks = chunk_blocks(initial_blocks, MAX_CHILDREN_PER_REQUEST)
        first_children = chunks[0] if chunks else []
        try:
            response = client.create_page(
                parent_page_id, title, children=first_children
            )
        except NotionAPIError as exc:
            log.warning(
                "%s: could not create page for %s: %s",
                top_level,
                rel_path,
                exc,
            )
            return 0
        except Exception:
            log.exception(
                "%s: unexpected error creating page for %s",
                top_level,
                rel_path,
            )
            return 0

        new_id = response.get("id") if isinstance(response, dict) else None
        if not new_id:
            log.error(
                "%s: create_page returned no id for %s: %r",
                top_level,
                rel_path,
                response,
            )
            return 0

        # Append any remaining chunks (a single large doc).
        for extra in chunks[1:]:
            try:
                client.append_block_children(new_id, extra)
            except NotionAPIError as exc:
                log.warning(
                    "%s: could not append chunk to %s (%s): %s",
                    top_level,
                    rel_path,
                    new_id,
                    exc,
                )
                # We still persist the new page id; partial body is fine.
                break

        _set_section_page(store, top_level, key, new_id, current_hash)
        return 1

    # Subsequent sync with changed content: append a fresh "Updated" block.
    update_blocks = _update_marker_block(iso_now(), content)
    chunks = chunk_blocks(update_blocks, MAX_CHILDREN_PER_REQUEST)
    success = False
    for chunk in chunks:
        try:
            client.append_block_children(page_id, chunk)
            success = True
        except NotionAPIError as exc:
            if exc.status_code == 404:
                log.warning(
                    "%s: page %s missing in Notion; clearing stored id so "
                    "next sync recreates it",
                    top_level,
                    page_id,
                )
                _set_section_page(store, top_level, key, None, None)
                return 0
            log.warning(
                "%s: could not append update to %s: %s",
                top_level,
                page_id,
                exc,
            )
            return 0
        except Exception:
            log.exception(
                "%s: unexpected error appending update to %s",
                top_level,
                page_id,
            )
            return 0

    if success:
        _set_section_page(store, top_level, key, page_id, current_hash)
        return 1
    return 0


def sync_knowledge_base(
    client: NotionHTTPClient,
    parent_page_id: str,
    store: RedisStore,
    kb_dir=None,
) -> int:
    """Mirror each Redis-backed KB doc as a child Notion page.

    Returns the number of pages created or updated this call (0 when the
    KB index is empty or all content is unchanged).

    ``kb_dir`` is accepted for backwards compatibility; KB docs are now
    iterated via ``store.list_kb_docs()`` regardless of the path passed.
    """
    if not parent_page_id:
        log.debug("knowledge_base: no parent page id configured; skipping")
        return 0

    touched = 0
    for rel_path in store.list_kb_docs():
        content = store.get_kb_doc(rel_path)
        if content is None:
            continue
        touched += _sync_one_doc(
            client,
            parent_page_id,
            rel_path,
            content,
            store,
            top_level="kb_pages",
            iso_now=_iso_now,
        )
    return touched


__all__ = ["sync_knowledge_base"]
