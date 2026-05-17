"""Live-data sync for the OpenClaw Mission Control screen pages.

Each screen page created by `scripts/setup_openclaw_mission_control.py`
holds a static spec at the top (source data, display rules, acceptance
criteria). This module appends a bridge-owned "Live View" code block to
the bottom of four of those pages and keeps it fresh on every daemon
tick:

    🧠 Memory          ← SHARED_MEMORY.md
    📄 Docs            ← KnowledgeBase/ index
    👥 Team            ← AGENT_ROLES.md + per-Owner last-activity
    📅 Calendar        ← SCHEDULE.md (operator/agent-managed)

State shape (under `openclaw_pages[screen_key]`):

    {
      "page_id":        "<existing>",     # set by setup script
      "live_block_id":  "<bridge-owned>", # set on first sync
      "live_hash":      "<sha256>"        # change detection
    }

The Tasks page is wired by setup script via a `link_to_page` block that
embeds the live Command Center database; this module does not touch it.
The Projects / Visual Office screens stay as spec pages — they need
data sources that don't exist locally yet.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from src.dashboard_sync import safe_truncate_markdown
from src.mission_control_renderers import _safe_read_text, _truncate
from src.notion_http import NotionAPIError, NotionHTTPClient
from src.state_store import StateStore
from src.warroom_format import parse_handoffs

log = logging.getLogger(__name__)


SCHEDULE_FILE = "SCHEDULE.md"
KB_DIR = "KnowledgeBase"
MAX_RENDER_LEN = 1900

# Stable Owner ordering — matches mission_control_renderers convention.
_OWNER_ORDER = ("Hermes", "OpenClaw", "Codex", "User")


# ---- Renderers -----------------------------------------------------------


def render_memory_screen(memory_path: Path) -> str:
    """🧠 Memory live view: SHARED_MEMORY.md contents."""
    text = _safe_read_text(memory_path)
    if not text or not text.strip():
        body = "(no shared memory yet — agents write to SHARED_MEMORY.md)"
    else:
        body = text.rstrip()
    return _truncate(f"## Live Memory\n\n{body}")


def render_docs_screen(kb_dir: Path) -> str:
    """📄 Docs live view: bullet list of every .md file under KnowledgeBase/."""
    if not kb_dir.exists() or not kb_dir.is_dir():
        return _truncate("## Live Docs\n\n(no KnowledgeBase directory)")
    try:
        candidates = sorted(kb_dir.rglob("*.md"))
    except OSError:
        return _truncate("## Live Docs\n\n(could not read KnowledgeBase)")
    entries: list[str] = []
    for path in candidates:
        try:
            rel = path.relative_to(kb_dir)
            if not path.is_file():
                continue
            size = path.stat().st_size
        except (ValueError, OSError):
            continue
        entries.append(f"- {rel} ({size} bytes)")
    if not entries:
        return _truncate(
            "## Live Docs\n\n(no .md files in KnowledgeBase yet)"
        )
    return _truncate("## Live Docs\n\n" + "\n".join(entries))


def render_team_screen(
    roles_path: Path, state_path: Path, handoffs_path: Path
) -> str:
    """👥 Team live view: AGENT_ROLES.md + per-Owner last activity timestamps."""
    roles_text = _safe_read_text(roles_path) or "(no AGENT_ROLES.md yet)"

    activity = _last_activity_per_owner(state_path, handoffs_path)
    if activity:
        activity_lines = ["## Per-agent last activity", ""]
        for owner in _ordered_owners(activity.keys()):
            ts = activity[owner]
            activity_lines.append(f"- **{owner}** — {ts or '(no recorded activity)'}")
        activity_block = "\n".join(activity_lines)
    else:
        activity_block = (
            "## Per-agent last activity\n\n"
            "(no handoff history yet)"
        )

    out = (
        f"{activity_block}\n\n"
        "## Roster (AGENT_ROLES.md)\n\n"
        f"{roles_text.rstrip()}"
    )
    return _truncate(out)


def render_calendar_screen(schedule_path: Path) -> str:
    """📅 Calendar live view: SCHEDULE.md contents (operator/agent-managed)."""
    text = _safe_read_text(schedule_path)
    if not text or not text.strip():
        body = (
            "(no SCHEDULE.md yet — agents and operators should write "
            "recurring tasks and cron jobs to "
            "`~/WarRoom/SCHEDULE.md` for this view to populate)"
        )
    else:
        body = text.rstrip()
    return _truncate(f"## Live Calendar\n\n{body}")


# ---- Team-screen helpers -------------------------------------------------


def _last_activity_per_owner(
    state_path: Path, handoffs_path: Path
) -> dict[str, Optional[str]]:
    """For each Owner that has handoffs, return the newest `last_synced_at`.

    Falls back to None when the bridge state file is missing or has no
    matching entry for an owner's handoff key.
    """
    handoffs_text = _safe_read_text(handoffs_path)
    if not handoffs_text:
        return {}

    state_blob: dict = {}
    raw_state = _safe_read_text(state_path)
    if raw_state:
        try:
            state_blob = json.loads(raw_state)
        except (json.JSONDecodeError, ValueError):
            state_blob = {}

    pages = state_blob.get("pages") if isinstance(state_blob, dict) else None
    pages = pages if isinstance(pages, dict) else {}
    by_key: dict[str, str] = {}
    for entry in pages.values():
        if not isinstance(entry, dict):
            continue
        key = entry.get("handoff_key")
        ts = entry.get("last_synced_at")
        if isinstance(key, str) and isinstance(ts, str):
            by_key[key] = ts

    result: dict[str, Optional[str]] = {}
    for key, fields in parse_handoffs(handoffs_text):
        owner = (fields.get("Owner") or "").strip()
        if not owner:
            continue
        ts = by_key.get(key)
        prev = result.get(owner)
        # Keep the newest timestamp per owner (ISO 8601 sorts lexically).
        if ts is not None and (prev is None or ts > prev):
            result[owner] = ts
        elif owner not in result:
            result[owner] = ts  # may be None
    return result


def _ordered_owners(owners) -> list[str]:
    seen = set()
    ordered: list[str] = []
    for canon in _OWNER_ORDER:
        if canon in owners:
            ordered.append(canon)
            seen.add(canon)
    for owner in owners:
        if owner not in seen:
            ordered.append(owner)
            seen.add(owner)
    return ordered


# ---- State helpers -------------------------------------------------------


def _screen_entry(store: StateStore, screen_key: str) -> Optional[dict]:
    pages = store.load().get("openclaw_pages") or {}
    entry = pages.get(screen_key)
    return entry if isinstance(entry, dict) else None


def _set_screen_fields(
    store: StateStore,
    screen_key: str,
    *,
    live_block_id: Optional[str] = None,
    live_hash: Optional[str] = None,
) -> None:
    with store.locked():
        state = store.load()
        pages = state.setdefault("openclaw_pages", {})
        entry = dict(pages.get(screen_key) or {})
        if live_block_id is not None:
            entry["live_block_id"] = live_block_id
        if live_hash is not None:
            entry["live_hash"] = live_hash
        pages[screen_key] = entry
        store.save(state)


# ---- Block payload + upsert ---------------------------------------------


def _code_block_payload(text: str) -> dict:
    return {
        "type": "code",
        "code": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "language": "markdown",
        },
    }


def _upsert_live_block(
    client: NotionHTTPClient,
    screen_key: str,
    page_id: str,
    live_block_id: Optional[str],
    payload: dict,
    store: StateStore,
) -> bool:
    """Update the live block in place, or append one if missing/deleted."""
    if live_block_id:
        try:
            client.update_block(live_block_id, payload)
            return True
        except NotionAPIError as exc:
            if exc.status_code != 404:
                log.exception(
                    "could not update live block %s on screen %s",
                    live_block_id,
                    screen_key,
                )
                return False
            log.warning(
                "live block %s missing on screen %s; recreating once",
                live_block_id,
                screen_key,
            )
        except Exception:
            log.exception(
                "unexpected error updating live block %s on screen %s",
                live_block_id,
                screen_key,
            )
            return False

    try:
        response = client.append_block_children(page_id, [payload])
    except Exception:
        log.exception(
            "could not append live block to screen %s (page %s)",
            screen_key,
            page_id,
        )
        return False
    results = (response or {}).get("results") or []
    if not results or not isinstance(results[0], dict):
        log.error("append_block_children returned no usable result for %s", screen_key)
        return False
    new_block_id = results[0].get("id")
    if not new_block_id:
        log.error("append_block_children result missing id for %s", screen_key)
        return False
    _set_screen_fields(store, screen_key, live_block_id=new_block_id)
    return True


# ---- Catalog -------------------------------------------------------------


def _catalog(warroom: Path) -> list[tuple[str, Callable[[], str]]]:
    return [
        ("screen_memory", lambda: render_memory_screen(warroom / "SHARED_MEMORY.md")),
        ("screen_docs", lambda: render_docs_screen(warroom / KB_DIR)),
        (
            "screen_team",
            lambda: render_team_screen(
                warroom / "AGENT_ROLES.md",
                warroom / ".notion_bridge_state.json",
                warroom / "HANDOFFS.md",
            ),
        ),
        (
            "screen_calendar",
            lambda: render_calendar_screen(warroom / SCHEDULE_FILE),
        ),
    ]


# ---- Public entry point -------------------------------------------------


def sync_openclaw_screens(
    client: NotionHTTPClient,
    warroom_path: os.PathLike | str,
    store: StateStore,
) -> int:
    """Refresh the live block on each Mission Control screen page.

    Returns the number of screens whose live block was created or
    updated this call. Screens whose source content hash matches the
    persisted hash skip the Notion API entirely.

    Screen pages that haven't been created yet (no `page_id` in state)
    are skipped silently — operators are expected to run
    `scripts/setup_openclaw_mission_control.py` first.
    """
    warroom = Path(warroom_path)
    pushed = 0

    for screen_key, renderer in _catalog(warroom):
        entry = _screen_entry(store, screen_key)
        if not entry or not entry.get("page_id"):
            continue

        try:
            body = renderer()
        except Exception:
            log.exception("renderer for %s failed; skipping", screen_key)
            continue

        text = safe_truncate_markdown(body)
        content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()

        if entry.get("live_hash") == content_hash:
            continue

        payload = _code_block_payload(text)
        ok = _upsert_live_block(
            client,
            screen_key,
            entry["page_id"],
            entry.get("live_block_id"),
            payload,
            store,
        )
        if ok:
            _set_screen_fields(store, screen_key, live_hash=content_hash)
            pushed += 1

    return pushed


# ---- One-time setup: link Command Center DB into 📋 Tasks page ---------


def link_tasks_page_to_command_center(
    client: NotionHTTPClient,
    database_id: str,
    store: StateStore,
) -> bool:
    """Append a `link_to_page` block on the 📋 Tasks page that embeds the
    live Command Center database. Idempotent — guarded by state flag.

    Returns True if the link was newly created, False if already linked
    or if the Tasks page id is not yet in state.
    """
    if not database_id:
        return False
    entry = _screen_entry(store, "screen_tasks")
    if not entry or not entry.get("page_id"):
        return False
    state = store.load()
    if state.get("tasks_page_linked"):
        return False

    block = {
        "object": "block",
        "type": "link_to_page",
        "link_to_page": {
            "type": "database_id",
            "database_id": database_id,
        },
    }
    try:
        client.append_block_children(entry["page_id"], [block])
    except Exception:
        log.exception("could not link Command Center DB into Tasks page")
        return False

    with store.locked():
        state = store.load()
        state["tasks_page_linked"] = True
        store.save(state)
    return True


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
