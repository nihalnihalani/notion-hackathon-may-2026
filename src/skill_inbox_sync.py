"""Skill Inbox sync: mirror Redis-backed skill runbooks as Notion child pages.

Same shape as ``knowledge_base_sync``, just pointed at the Redis-backed
skill index (``RedisStore.list_skills``) and persisted under the
``skill_pages`` top-level key inside the bridge-state JSON blob. Section
keys, content hashing, create-on-first-sync, append-on-change, forget-on-404
all follow the KB module so the surrounding daemon code can wire both in
identically.
"""

from __future__ import annotations

import logging

from src.knowledge_base_sync import _iso_now, _sync_one_doc
from src.notion_http import NotionHTTPClient
from src.redis_store import RedisStore

log = logging.getLogger(__name__)


def sync_skill_inbox(
    client: NotionHTTPClient,
    parent_page_id: str,
    store: RedisStore,
    skill_dir=None,
) -> int:
    """Mirror each Redis-backed skill doc as a child Notion page.

    Returns the number of pages created or updated this call.

    ``skill_dir`` is accepted for backwards compatibility; skill docs are
    now iterated via ``store.list_skills()`` regardless of the path passed.
    """
    if not parent_page_id:
        log.debug("skill_inbox: no parent page id configured; skipping")
        return 0

    touched = 0
    for name in store.list_skills():
        content = store.get_skill(name)
        if content is None:
            continue
        touched += _sync_one_doc(
            client,
            parent_page_id,
            name,
            content,
            store,
            top_level="skill_pages",
            iso_now=_iso_now,
        )
    return touched


__all__ = ["sync_skill_inbox"]
