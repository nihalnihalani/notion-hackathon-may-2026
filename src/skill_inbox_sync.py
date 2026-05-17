"""Skill Inbox sync: mirror local skill runbooks as Notion child pages.

Same shape as `knowledge_base_sync`, just pointed at `~/WarRoom/Skill_Inbox/`
and persisted under the `skill_pages` top-level key in state. Section keys,
content hashing, create-on-first-sync, append-on-change, forget-on-404 all
follow the KB module so the surrounding daemon code can wire both in
identically.
"""

from __future__ import annotations

import logging
from pathlib import Path

from src.knowledge_base_sync import _iso_now, _iter_md_files, _sync_one_file
from src.notion_http import NotionHTTPClient
from src.state_store import StateStore

log = logging.getLogger(__name__)


def sync_skill_inbox(
    client: NotionHTTPClient,
    parent_page_id: str,
    skill_dir: Path | str,
    store: StateStore,
) -> int:
    """Mirror each `.md` file under `skill_dir` as a child Notion page.

    Returns the number of pages created or updated this call.
    """
    if not parent_page_id:
        log.debug("skill_inbox: no parent page id configured; skipping")
        return 0

    root = Path(skill_dir)
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
            bucket_getter=store.get_skill_page,
            bucket_setter=store.set_skill_page,
            iso_now=_iso_now,
        )
    return touched


__all__ = ["sync_skill_inbox"]
