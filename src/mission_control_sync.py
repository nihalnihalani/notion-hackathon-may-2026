"""Mission Control multi-page syncer (Redis-backed).

Owns five bridge-owned Notion child pages under a Mission Control parent
page. Each section's body lives as exactly one code block on its child
page; that block is updated in place when content changes. State is
persisted inside the bridge-state JSON blob under
``mission_control_pages: {section_key: {page_id, block_id}}`` and the
per-section content hash under
``mission_control: {section_key: {block_id, hash}}`` for backwards
compatibility with the legacy single-page mode.

Two operating modes are still supported for back-compat:

1. **Page-tree mode (preferred)**: ``mission_control_pages`` populated by
   ``scripts/setup_mission_control.py``. Each section's body block is
   updated in place on its dedicated child page. Falls back to legacy
   mode if a section's state entry is missing.

2. **Legacy mode**: no page tree state — the syncer pushes one code block
   per section directly onto the ``dashboard_page_id`` argument.

Either way, hash-based idempotency and recreate-on-404 are preserved.

Renderers all read from Redis via ``RedisStore`` (Path B migration); the
syncer hands the store through unchanged.
"""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Any, Callable, Mapping, Optional

from src.dashboard_sync import safe_truncate_markdown
from src.mission_control_renderers import (
    render_agent_history,
    render_bridge_stats,
    render_knowledge_base_index,
    render_live_state,
    render_protocol_and_roles,
    render_shared_memory,
    render_skill_registry,
)
from src.notion_http import NotionAPIError, NotionHTTPClient
from src.redis_store import RedisStore

log = logging.getLogger(__name__)


# ---- Section catalog -------------------------------------------------------

_Sections = list[tuple[str, str, Callable[[RedisStore], str]]]


def _sections() -> _Sections:
    """Return the ordered section catalog.

    Each renderer takes the same ``RedisStore`` and pulls the relevant
    logical name out of Redis. The catalog no longer needs a War Room
    path because there's no filesystem read left in the renderer family.
    """
    return [
        ("live_state", "📊 Live State", render_live_state),
        ("knowledge_base", "📚 Knowledge Base", render_knowledge_base_index),
        ("skill_registry", "🛠 Skill Registry", render_skill_registry),
        ("protocol_and_roles", "📋 Protocol and Roles", render_protocol_and_roles),
        ("bridge_stats", "📈 Bridge Stats", render_bridge_stats),
    ]


# ---- Block payload ---------------------------------------------------------


def _format_block_text(title: str, body: str) -> str:
    return safe_truncate_markdown(f"# {title}\n\n{body}")


def _code_block_payload(text: str) -> dict:
    return {
        "type": "code",
        "code": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "language": "markdown",
        },
    }


# ---- Bridge-state helpers --------------------------------------------------


def _get_mc_page_entry(state: Mapping[str, Any], section_key: str) -> Optional[dict]:
    pages = state.get("mission_control_pages") if isinstance(state, Mapping) else None
    if not isinstance(pages, Mapping):
        return None
    entry = pages.get(section_key)
    return dict(entry) if isinstance(entry, Mapping) else None


def _set_mc_page_entry(
    store: RedisStore,
    section_key: str,
    *,
    page_id: Optional[str] = None,
    block_id: Optional[Any] = ...,
) -> None:
    """Mutate ``mission_control_pages[section_key]`` inside the state JSON.

    Sentinel default lets the caller update one field without touching the
    other; matches the old ``StateStore`` partial-update semantics. Caller
    must already hold ``store.locked()``.
    """
    state = store.get_bridge_state()
    pages = state.setdefault("mission_control_pages", {})
    if not isinstance(pages, dict):
        pages = {}
        state["mission_control_pages"] = pages
    entry = dict(pages.get(section_key) or {})
    if page_id is not None:
        entry["page_id"] = page_id
    if block_id is not ...:
        entry["block_id"] = block_id
    pages[section_key] = entry
    store.set_bridge_state(state)


def _get_mc_block(state: Mapping[str, Any], section_key: str) -> Optional[str]:
    """Legacy single-page block-id lookup (kept for back-compat)."""
    mc = state.get("mission_control") if isinstance(state, Mapping) else None
    if not isinstance(mc, Mapping):
        return None
    entry = mc.get(section_key)
    if not isinstance(entry, Mapping):
        return None
    block_id = entry.get("block_id")
    return block_id if isinstance(block_id, str) else None


def _get_mc_hash(state: Mapping[str, Any], section_key: str) -> Optional[str]:
    mc = state.get("mission_control") if isinstance(state, Mapping) else None
    if not isinstance(mc, Mapping):
        return None
    entry = mc.get(section_key)
    if not isinstance(entry, Mapping):
        return None
    content_hash = entry.get("hash")
    return content_hash if isinstance(content_hash, str) else None


def _set_mc_block(
    store: RedisStore, section_key: str, block_id: Optional[str]
) -> None:
    """Legacy single-page block-id setter."""
    state = store.get_bridge_state()
    mc = state.setdefault("mission_control", {})
    if not isinstance(mc, dict):
        mc = {}
        state["mission_control"] = mc
    entry = dict(mc.get(section_key) or {})
    entry["block_id"] = block_id
    entry.setdefault("hash", None)
    mc[section_key] = entry
    store.set_bridge_state(state)


def _set_mc_hash(
    store: RedisStore, section_key: str, content_hash: Optional[str]
) -> None:
    state = store.get_bridge_state()
    mc = state.setdefault("mission_control", {})
    if not isinstance(mc, dict):
        mc = {}
        state["mission_control"] = mc
    entry = dict(mc.get(section_key) or {})
    entry["hash"] = content_hash
    entry.setdefault("block_id", None)
    mc[section_key] = entry
    store.set_bridge_state(state)


# ---- Page-tree updater (preferred path) -----------------------------------


def _update_section_on_page(
    client: NotionHTTPClient,
    section_key: str,
    page_id: str,
    block_id: Optional[str],
    payload: dict,
    store: RedisStore,
) -> bool:
    """Update the body block on a section child page; recreate on 404.

    Returns True if the Notion API mutated state, False on hard failure.
    """
    if block_id:
        try:
            client.update_block(block_id, payload)
            return True
        except NotionAPIError as exc:
            if exc.status_code != 404:
                log.exception(
                    "could not update mission control block %s on page %s",
                    block_id,
                    page_id,
                )
                return False
            log.warning(
                "mission control block %s missing on page %s; recreating once",
                block_id,
                page_id,
            )
        except Exception:
            log.exception("unexpected error updating block %s", block_id)
            return False

    # Recreate the body block on the existing section page.
    try:
        resp = client.append_block_children(page_id, [payload])
    except Exception:
        log.exception(
            "could not append body block to mission control page %s", page_id
        )
        return False
    results = (resp or {}).get("results") or []
    if not results or not isinstance(results[0], dict):
        log.error("Notion returned no results when appending to page %s", page_id)
        return False
    new_block_id = results[0].get("id")
    if not new_block_id:
        log.error("Notion append response missing id: %r", results[0])
        return False
    with store.locked():
        _set_mc_page_entry(store, section_key, block_id=new_block_id)
    return True


# ---- Legacy single-page updater (kept for backwards compatibility) --------


def _legacy_upsert_on_dashboard(
    client: NotionHTTPClient,
    dashboard_page_id: str,
    section_key: str,
    payload: dict,
    store: RedisStore,
) -> bool:
    """Old behavior: 5 blocks under one shared dashboard page."""
    block_id = _get_mc_block(store.get_bridge_state(), section_key)
    if block_id:
        try:
            client.update_block(block_id, payload)
            return True
        except NotionAPIError as exc:
            if exc.status_code != 404:
                log.exception("could not update mission control block %s", block_id)
                return False
            log.warning(
                "mission control block %s missing in Notion; recreating once",
                block_id,
            )
            with store.locked():
                _set_mc_block(store, section_key, None)
            block_id = None
        except Exception:
            log.exception("unexpected error updating block %s; will retry", block_id)
            return False

    try:
        response = client.append_block_children(dashboard_page_id, [payload])
    except Exception:
        log.exception(
            "could not create mission control block for section %r", section_key
        )
        return False
    results = (response or {}).get("results") or []
    if not results:
        log.error("Notion returned no results for section %r", section_key)
        return False
    new_block = results[0]
    new_id = new_block.get("id") if isinstance(new_block, dict) else None
    if not new_id:
        log.error("Notion create response missing id: %r", new_block)
        return False
    with store.locked():
        _set_mc_block(store, section_key, new_id)
    return True


# ---- Public entry point ----------------------------------------------------


def sync_mission_control(
    client: NotionHTTPClient,
    dashboard_page_id: str,
    store: RedisStore,
    warroom_path: Optional[os.PathLike | str] = None,
) -> int:
    """Upsert each Mission Control section.

    If ``mission_control_pages`` state exists (page-tree mode), updates each
    section's body block on its child page. Otherwise falls back to the
    legacy "blocks on the dashboard page" behavior.

    Returns the number of sections whose Notion content was created or
    updated this call. Hash-matched sections skip the API.

    ``warroom_path`` is accepted for backwards compatibility; renderers
    read content from ``store`` directly.
    """
    if not dashboard_page_id:
        return 0

    pushed = 0

    for section_key, title, renderer in _sections():
        try:
            body = renderer(store)
        except Exception:
            log.exception("renderer for section %r failed; skipping", section_key)
            continue

        text = _format_block_text(title, body)
        content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()

        state = store.get_bridge_state()
        if _get_mc_hash(state, section_key) == content_hash:
            continue

        payload = _code_block_payload(text)

        page_entry = _get_mc_page_entry(state, section_key)
        if page_entry and page_entry.get("page_id"):
            success = _update_section_on_page(
                client,
                section_key,
                page_entry["page_id"],
                page_entry.get("block_id"),
                payload,
                store,
            )
        else:
            success = _legacy_upsert_on_dashboard(
                client, dashboard_page_id, section_key, payload, store
            )

        if success:
            with store.locked():
                _set_mc_hash(store, section_key, content_hash)
            pushed += 1

    return pushed
