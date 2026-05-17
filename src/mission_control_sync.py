"""Mission Control multi-page syncer.

Owns five bridge-owned Notion child pages under a Mission Control parent
page. Each section's body lives as exactly one code block on its child
page; that block is updated in place when content changes. State is
persisted under `mission_control_pages: {section_key: {page_id, block_id}}`.

Two operating modes for backwards compatibility:

1. **Page-tree mode (preferred)**: `state["mission_control_pages"]` is
   populated (e.g. by `scripts/setup_mission_control.py`). Each section's
   body block is updated in place on its dedicated child page. Falls back
   to legacy mode if a section's state entry is missing.

2. **Legacy mode**: no page tree state — the syncer pushes one code block
   per section directly onto the `dashboard_page_id` argument. This is
   what the original Mission Control sync did before child pages existed.

Either way, hash-based idempotency and recreate-on-404 are preserved.
"""

from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
from typing import Callable, Optional

from src.activity_timeline import render_activity_timeline
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
from src.state_store import StateStore

log = logging.getLogger(__name__)


# ---- Section catalog -------------------------------------------------------

_Sections = list[tuple[str, str, Callable[[Path], str]]]


def _sections(warroom: Path) -> _Sections:
    """Return the ordered section catalog bound to `warroom`."""
    return [
        (
            "live_state",
            "📊 Live State",
            lambda w: render_live_state(w / "CURRENT_STATE.md"),
        ),
        (
            "knowledge_base",
            "📚 Knowledge Base",
            lambda w: render_knowledge_base_index(w / "KnowledgeBase"),
        ),
        (
            "skill_registry",
            "🛠 Skill Registry",
            lambda w: render_skill_registry(w / "SKILL_REGISTRY.md"),
        ),
        (
            "protocol_and_roles",
            "📋 Protocol and Roles",
            lambda w: render_protocol_and_roles(
                w / "PROTOCOL.md", w / "AGENT_ROLES.md"
            ),
        ),
        (
            "bridge_stats",
            "📈 Bridge Stats",
            lambda w: render_bridge_stats(w / ".notion_bridge_state.json"),
        ),
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


# ---- State helpers ---------------------------------------------------------


def _get_mc_page_entry(store: StateStore, section_key: str) -> Optional[dict]:
    pages = store.load().get("mission_control_pages") or {}
    entry = pages.get(section_key)
    return entry if isinstance(entry, dict) else None


def _set_mc_page_entry(
    store: StateStore,
    section_key: str,
    *,
    page_id: Optional[str] = None,
    block_id: Optional[str] = None,
) -> None:
    with store.locked():
        state = store.load()
        pages = state.setdefault("mission_control_pages", {})
        entry = dict(pages.get(section_key) or {})
        if page_id is not None:
            entry["page_id"] = page_id
        if block_id is not None or "block_id" not in entry:
            entry["block_id"] = block_id
        pages[section_key] = entry
        store.save(state)


# ---- Page-tree updater (preferred path) -----------------------------------


def _update_section_on_page(
    client: NotionHTTPClient,
    section_key: str,
    page_id: str,
    block_id: Optional[str],
    payload: dict,
    store: StateStore,
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
    _set_mc_page_entry(store, section_key, block_id=new_block_id)
    return True


# ---- Legacy single-page updater (kept for backwards compatibility) --------


def _legacy_upsert_on_dashboard(
    client: NotionHTTPClient,
    dashboard_page_id: str,
    section_key: str,
    payload: dict,
    store: StateStore,
) -> bool:
    """Old behavior: 5 blocks under one shared dashboard page."""
    block_id = store.get_mc_block(section_key)
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
            store.set_mc_block(section_key, None)
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
    store.set_mc_block(section_key, new_id)
    return True


# ---- Public entry point ----------------------------------------------------


def sync_mission_control(
    client: NotionHTTPClient,
    dashboard_page_id: str,
    warroom_path: os.PathLike | str,
    store: StateStore,
) -> int:
    """Upsert each Mission Control section.

    If `mission_control_pages` state exists (page-tree mode), updates each
    section's body block on its child page. Otherwise falls back to the
    legacy "blocks on the dashboard page" behavior.

    Returns the number of sections whose Notion content was created or
    updated this call. Hash-matched sections skip the API.
    """
    if not dashboard_page_id:
        return 0

    warroom = Path(warroom_path)
    pushed = 0

    for section_key, title, renderer in _sections(warroom):
        try:
            body = renderer(warroom)
        except Exception:
            log.exception("renderer for section %r failed; skipping", section_key)
            continue

        text = _format_block_text(title, body)
        content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()

        if store.get_mc_hash(section_key) == content_hash:
            continue

        payload = _code_block_payload(text)

        page_entry = _get_mc_page_entry(store, section_key)
        success = False
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
            store.set_mc_hash(section_key, content_hash)
            pushed += 1

    return pushed
