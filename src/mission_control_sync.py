"""Mission Control multi-block syncer.

Owns one bridge-owned Notion code block per Mission Control section under
the dashboard page. Each section's body is produced by a pure renderer
from `src.mission_control_renderers`, hashed, and upserted in place with
the same create-when-missing / recreate-on-404 contract as
`src.dashboard_sync`.

Public contract:

    sync_mission_control(client, dashboard_page_id, warroom_path, store) -> int

Behavior per section:

- If the section's hash matches the persisted hash, skip the API.
- If no block id is stored, append exactly one new code block under the
  dashboard page and persist the new id.
- If a block id is stored, `update_block` it; on Notion 404, forget the
  id and recreate the block once. Never append endless duplicates.

The internal `_sections(warroom)` and `_format_block_text(title, body)`
helpers are intentionally module-private but stable — tests monkeypatch
`_sections` to swap in fixture content without touching the filesystem.
"""

from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
from typing import Callable

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
    """Return the ordered section catalog bound to `warroom`.

    Each tuple is (section_key, human_title, renderer). The section_key is
    stable across runs and used as the state-store handle; the title is
    rendered into the block header; the renderer takes the WARROOM root
    and returns the markdown body.
    """
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
    """Compose the block body and truncate to one Notion block limit."""
    return safe_truncate_markdown(f"# {title}\n\n{body}")


def _code_block_payload(text: str) -> dict:
    return {
        "type": "code",
        "code": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "language": "markdown",
        },
    }


# ---- Public entry point ----------------------------------------------------


def sync_mission_control(
    client: NotionHTTPClient,
    dashboard_page_id: str,
    warroom_path: os.PathLike | str,
    store: StateStore,
) -> int:
    """Upsert one bridge-owned code block per Mission Control section.

    Returns the number of sections whose Notion block was created or
    updated on this call. Sections whose rendered content hash matches
    the stored hash skip the API entirely.
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
        block_id = store.get_mc_block(section_key)

        if block_id:
            try:
                client.update_block(block_id, payload)
            except NotionAPIError as exc:
                if exc.status_code == 404:
                    log.warning(
                        "mission control block %s missing in Notion; recreating once",
                        block_id,
                    )
                    store.set_mc_block(section_key, None)
                    block_id = None
                else:
                    log.exception(
                        "could not update mission control block %s", block_id
                    )
                    continue
            except Exception:
                log.exception(
                    "unexpected error updating mission control block %s; will retry",
                    block_id,
                )
                continue

        if not block_id:
            try:
                response = client.append_block_children(
                    dashboard_page_id, [payload]
                )
            except Exception:
                log.exception(
                    "could not create mission control block for section %r",
                    section_key,
                )
                continue
            results = (response or {}).get("results") or []
            if not results:
                log.error(
                    "Notion returned no results when creating mission control "
                    "block for section %r",
                    section_key,
                )
                continue
            new_block = results[0]
            new_id = new_block.get("id") if isinstance(new_block, dict) else None
            if not new_id:
                log.error(
                    "Notion mission control create response missing id: %r",
                    new_block,
                )
                continue
            store.set_mc_block(section_key, new_id)

        store.set_mc_hash(section_key, content_hash)
        pushed += 1

    return pushed
