"""Knowledge Base sync: mirror local `.md` notes as Notion child pages.

For each markdown file under `kb_dir`, the bridge maintains a single Notion
child page under `parent_page_id`. The mapping is persisted in
`.notion_bridge_state.json` under top-level key `kb_pages`:

```json
{
  "kb_pages": {
    "<section_key>": {"page_id": "<notion-page-id>", "hash": "sha256..."}
  }
}
```

Pattern (matching `dashboard_sync` / `mission_control_sync`):

- Section key: SHA-1 of the file's relative posix path (stable, filesystem-
  agnostic). Easy to debug; small enough to fit anywhere.
- First sync: `client.create_page(parent_page_id, title, children=blocks)`
  and persist `{page_id, hash}`.
- Unchanged content: skip; zero API calls.
- Content changed: append a single fresh "Updated <iso>" code block via
  `client.append_block_children` and refresh the stored hash. The original
  page is never recreated.
- 404 on append: forget the page id so the next sync recreates the page.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from src.markdown_to_notion import chunk_blocks, markdown_to_blocks
from src.notion_http import NotionAPIError, NotionHTTPClient
from src.state_store import StateStore

log = logging.getLogger(__name__)


# Notion limits a single create-page or children-append request to 100
# children. We keep slightly below that to be safe across SDK changes.
MAX_CHILDREN_PER_REQUEST = 100


def _section_key(rel_path: str) -> str:
    """Stable, hash-based section key for a relative markdown path."""
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


def _iter_md_files(root: Path):
    """Yield `(absolute_path, relative_posix_path)` for every .md under root."""
    if not root.exists() or not root.is_dir():
        return
    for path in sorted(root.rglob("*.md")):
        if path.is_file():
            yield path, path.relative_to(root).as_posix()


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


def _sync_one_file(
    client: NotionHTTPClient,
    parent_page_id: str,
    path: Path,
    rel_path: str,
    store: StateStore,
    *,
    bucket_getter,
    bucket_setter,
    iso_now,
) -> int:
    """Sync a single markdown file. Returns 1 if API called, else 0."""
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as exc:
        log.warning("could not read %s: %s", path, exc)
        return 0

    key = _section_key(rel_path)
    current_hash = _content_hash(content)
    entry = bucket_getter(key)
    page_id = entry.get("page_id") if isinstance(entry, dict) else None
    stored_hash = entry.get("hash") if isinstance(entry, dict) else None

    if page_id and stored_hash == current_hash:
        return 0

    # First sync (or recreated after a 404): create the page with the body.
    if not page_id:
        title = _derive_title(content, fallback=path.stem)
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
                "knowledge_base: could not create page for %s: %s",
                rel_path,
                exc,
            )
            return 0
        except Exception:
            log.exception(
                "knowledge_base: unexpected error creating page for %s",
                rel_path,
            )
            return 0

        new_id = response.get("id") if isinstance(response, dict) else None
        if not new_id:
            log.error(
                "knowledge_base: create_page returned no id for %s: %r",
                rel_path,
                response,
            )
            return 0

        # Append any remaining chunks (a single large file).
        for extra in chunks[1:]:
            try:
                client.append_block_children(new_id, extra)
            except NotionAPIError as exc:
                log.warning(
                    "knowledge_base: could not append chunk to %s (%s): %s",
                    rel_path,
                    new_id,
                    exc,
                )
                # We still persist the new page id; partial body is fine.
                break

        bucket_setter(key, new_id, current_hash)
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
                    "knowledge_base: page %s missing in Notion; clearing "
                    "stored id so next sync recreates it",
                    page_id,
                )
                bucket_setter(key, None, None)
                return 0
            log.warning(
                "knowledge_base: could not append update to %s: %s",
                page_id,
                exc,
            )
            return 0
        except Exception:
            log.exception(
                "knowledge_base: unexpected error appending update to %s",
                page_id,
            )
            return 0

    if success:
        bucket_setter(key, page_id, current_hash)
        return 1
    return 0


def sync_knowledge_base(
    client: NotionHTTPClient,
    parent_page_id: str,
    kb_dir: Path | str,
    store: StateStore,
) -> int:
    """Mirror each `.md` file under `kb_dir` as a child Notion page.

    Returns the number of pages created or updated this call (0 when the
    directory is missing/empty or all content is unchanged).
    """
    if not parent_page_id:
        log.debug("knowledge_base: no parent page id configured; skipping")
        return 0

    root = Path(kb_dir)
    if not root.exists() or not root.is_dir():
        return 0

    touched = 0
    for path, rel in _iter_md_files(root):
        touched += _sync_one_file(
            client,
            parent_page_id,
            path,
            rel,
            store,
            bucket_getter=store.get_kb_page,
            bucket_setter=store.set_kb_page,
            iso_now=_iso_now,
        )
    return touched


__all__ = ["sync_knowledge_base"]
