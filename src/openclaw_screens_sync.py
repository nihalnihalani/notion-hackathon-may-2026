"""Two-way live-data sync for the OpenClaw Mission Control screens (Redis-backed).

For each screen page created by ``scripts/setup_openclaw_mission_control.py``
the bridge owns one editable "Live View" code block. Depending on the
screen, the block is either:

* **Bidirectional** (Memory / Calendar / Team / Projects): the block's
  content IS the corresponding logical War Room file (stored in Redis
  under ``wr:file:<NAME>``). Edits on either side propagate to the other.
  Last-edit-wins on conflict:

      1. Read local content via ``RedisStore.get_file`` plus the
         per-screen ``last_local_updated_at`` timestamp recorded the last
         time we wrote that file from Notion (or it was changed locally).
      2. ``client.get_block(live_block_id)`` -> remote content +
         ``last_edited_time``.
      3. Compare both hashes to the stored ``live_hash``:

         - Both match stored: no-op.
         - Only local changed: push local -> Notion.
         - Only remote changed: pull Notion -> Redis file (and bump
           ``last_local_updated_at``).
         - Both changed: pick the newer timestamp; log the conflict.

      4. Persist the winner's hash so the next tick is idempotent.

* **Read-only derived** (Docs / Visual Office): the block is computed
  from Redis-backed listings or bridge state. Hash-based skip; never
  pulled back from Notion.

Plan §2 stays honored: no agent CLIs are invoked. The bridge moves
text between Notion and Redis; agents observe / write the same Redis
keys (and the local-file mirror process materialises them onto disk
under ``~/WarRoom/`` for human-facing tools that still want files).

State shape (inside the bridge-state JSON blob, under
``openclaw_pages[screen_key]``):

    {
      "page_id":                "<existing>",
      "live_block_id":          "<bridge-owned>",
      "live_hash":              "<sha256 of last successfully synced content>",
      "last_local_updated_at":  "<ISO 8601 UTC, replaces filesystem mtime>"
    }
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Mapping, Optional

from src.dashboard_sync import safe_truncate_markdown
from src.mission_control_renderers import _truncate
from src.notion_http import NotionAPIError, NotionHTTPClient
from src.redis_store import RedisStore
from src.warroom_format import parse_handoffs

log = logging.getLogger(__name__)


SCHEDULE_FILE = "SCHEDULE.md"
PROJECTS_FILE = "PROJECTS.md"
MEMORY_FILE = "SHARED_MEMORY.md"
ROLES_FILE = "AGENT_ROLES.md"
HANDOFFS_FILE = "HANDOFFS.md"  # not read from filesystem; rendered from Redis
STATE_FILE = ".notion_bridge_state.json"  # kept as a constant for compat only
KB_DIR = "KnowledgeBase"  # kept as a constant for compat only
MAX_RENDER_LEN = 1900

_OWNER_ORDER = ("Hermes", "OpenClaw", "Codex", "User")
_NOTION_TS = "%Y-%m-%dT%H:%M:%S.%f%z"
_NOTION_TS_NO_MICRO = "%Y-%m-%dT%H:%M:%S%z"


# ---- Helpers --------------------------------------------------------------


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _extract_block_text(block: dict) -> str:
    """Pull plain text out of a Notion code/paragraph block's rich_text."""
    if not isinstance(block, dict):
        return ""
    for container_key in ("code", "paragraph", "quote"):
        section = block.get(container_key)
        if isinstance(section, dict):
            rich = section.get("rich_text") or []
            return "".join(
                (rt.get("text") or {}).get("content", "")
                for rt in rich
                if isinstance(rt, dict)
            )
    return ""


def _parse_notion_ts(value: Optional[str]) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    # Notion returns RFC 3339, sometimes with microseconds, always with Z.
    normalized = value.replace("Z", "+00:00")
    for fmt in (_NOTION_TS, _NOTION_TS_NO_MICRO):
        try:
            return datetime.strptime(normalized, fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def _code_block_payload(text: str) -> dict:
    return {
        "type": "code",
        "code": {
            "rich_text": [{"type": "text", "text": {"content": text}}],
            "language": "markdown",
        },
    }


# ---- Bridge-state helpers --------------------------------------------------


def _screen_entry(state: Mapping[str, Any], screen_key: str) -> Optional[dict]:
    pages = state.get("openclaw_pages") if isinstance(state, Mapping) else None
    if not isinstance(pages, Mapping):
        return None
    entry = pages.get(screen_key)
    return dict(entry) if isinstance(entry, Mapping) else None


def _set_screen_fields(
    store: RedisStore,
    screen_key: str,
    *,
    live_block_id: Optional[Any] = ...,
    live_hash: Optional[Any] = ...,
    last_local_updated_at: Optional[Any] = ...,
) -> None:
    """Update one screen's bridge-state entry in place.

    Uses sentinel defaults so the caller can update one field at a time
    without clobbering the others — same partial-update semantics as the
    old StateStore helper. Caller must already hold ``store.locked()``.
    """
    state = store.get_bridge_state()
    pages = state.setdefault("openclaw_pages", {})
    if not isinstance(pages, dict):
        pages = {}
        state["openclaw_pages"] = pages
    entry = dict(pages.get(screen_key) or {})
    if live_block_id is not ...:
        entry["live_block_id"] = live_block_id
    if live_hash is not ...:
        entry["live_hash"] = live_hash
    if last_local_updated_at is not ...:
        entry["last_local_updated_at"] = last_local_updated_at
    pages[screen_key] = entry
    store.set_bridge_state(state)


def _stamp_local_update(store: RedisStore, screen_key: str) -> str:
    """Record that we just mutated the local Redis-backed file for this screen.

    Replaces filesystem mtime: every time the bridge writes a screen's
    backing file (or seeds it on first sync), we capture the wall-clock
    timestamp so the bidirectional conflict resolution can still ask
    "who edited last, local or Notion?".
    """
    when = _now_iso()
    _set_screen_fields(store, screen_key, last_local_updated_at=when)
    return when


# ---- Read-only derived renderers (Docs, Visual Office) -------------------


def render_docs_screen(store: RedisStore) -> str:
    """List every KB doc stored in Redis with its byte size."""
    rel_paths = store.list_kb_docs()
    entries: list[str] = []
    for rel in sorted(rel_paths):
        body = store.get_kb_doc(rel)
        if body is None:
            continue
        size = len(body.encode("utf-8"))
        entries.append(f"- {rel} ({size} bytes)")
    if not entries:
        return _truncate("## Live Docs\n\n(no .md files in KnowledgeBase yet)")
    return _truncate("## Live Docs\n\n" + "\n".join(entries))


def render_visual_office(
    store: RedisStore, now: Optional[datetime] = None
) -> str:
    """🏢 Visual Office — per-agent status board derived from bridge state.

    Each agent's status is computed from the newest ``last_synced_at``
    timestamp on any handoff they own:
        🟢 Active  — last activity within 5 minutes
        🟡 Idle    — 5 to 60 minutes
        ⚫ Away    — older or never recorded
    """
    activity = _last_activity_per_owner(store)
    if not activity:
        return _truncate(
            "## 🏢 Visual Office\n\n(no agent activity recorded yet)"
        )
    now_dt = now or datetime.now(timezone.utc)
    lines = ["## 🏢 Visual Office", ""]
    for owner in _ordered_owners(activity.keys()):
        ts = activity[owner]
        lines.append(
            f"- {_status_badge(ts, now_dt)} **{owner}** — last active: {ts or '(never)'}"
        )
    return _truncate("\n".join(lines))


def _status_badge(ts: Optional[str], now: datetime) -> str:
    if not ts:
        return "⚫ AWAY  "
    last = _parse_notion_ts(ts)
    if last is None:
        return "⚫ AWAY  "
    delta_min = (now - last).total_seconds() / 60
    if delta_min < 5:
        return "🟢 ACTIVE"
    if delta_min < 60:
        return "🟡 IDLE  "
    return "⚫ AWAY  "


# ---- Team-screen helpers (also used by Visual Office) -------------------


def _last_activity_per_owner(store: RedisStore) -> dict[str, Optional[str]]:
    """Derive {owner: last_synced_at_iso} from Redis handoffs + bridge state.

    Iterates the materialised HANDOFFS view (so the result includes any
    handoff present in Redis even if it was inserted out-of-band) and
    joins against bridge state to pick up per-page ``last_synced_at``.
    """
    handoffs_text = store.render_handoffs_md()
    if not handoffs_text:
        return {}

    state_blob = store.get_bridge_state() or {}
    pages = state_blob.get("pages") if isinstance(state_blob, Mapping) else None
    pages = pages if isinstance(pages, Mapping) else {}
    by_key: dict[str, str] = {}
    for entry in pages.values():
        if not isinstance(entry, Mapping):
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
        if ts is not None and (prev is None or ts > prev):
            result[owner] = ts
        elif owner not in result:
            result[owner] = ts
    return result


def _ordered_owners(owners: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    owners_set = set(owners)
    for canon in _OWNER_ORDER:
        if canon in owners_set:
            ordered.append(canon)
            seen.add(canon)
    for owner in owners:
        if owner not in seen:
            ordered.append(owner)
            seen.add(owner)
    return ordered


# ---- Bidirectional sync ---------------------------------------------------


@dataclass(frozen=True)
class BidirectionalSpec:
    """A screen whose Notion block is a round-trip mirror of a Redis file."""
    screen_key: str
    local_file: str


SyncOutcome = str  # "created" | "unchanged" | "pushed" | "pulled" | "conflict_local" | "conflict_remote" | "skipped" | "error"


def _bidirectional_specs() -> list[BidirectionalSpec]:
    return [
        BidirectionalSpec("screen_memory", MEMORY_FILE),
        BidirectionalSpec("screen_calendar", SCHEDULE_FILE),
        BidirectionalSpec("screen_team", ROLES_FILE),
        BidirectionalSpec("screen_projects", PROJECTS_FILE),
    ]


def _sync_one_bidirectional(
    client: NotionHTTPClient,
    spec: BidirectionalSpec,
    page_id: str,
    live_block_id: Optional[str],
    store: RedisStore,
) -> SyncOutcome:
    local_content = store.get_file(spec.local_file) or ""
    local_hash = _sha256(local_content)

    # First-time bootstrap: append the editable block from local content.
    if not live_block_id:
        payload = _code_block_payload(safe_truncate_markdown(local_content))
        try:
            resp = client.append_block_children(page_id, [payload])
        except Exception:
            log.exception(
                "could not append initial bidirectional block for %s",
                spec.screen_key,
            )
            return "error"
        results = (resp or {}).get("results") or []
        if not results or not isinstance(results[0], dict):
            return "error"
        new_id = results[0].get("id")
        if not new_id:
            return "error"
        with store.locked():
            _set_screen_fields(
                store,
                spec.screen_key,
                live_block_id=new_id,
                live_hash=local_hash,
                last_local_updated_at=_now_iso(),
            )
        return "created"

    # Fetch remote content + last_edited_time.
    try:
        block = client.get_block(live_block_id)
    except NotionAPIError as exc:
        if exc.status_code == 404:
            log.warning(
                "%s block %s gone in Notion; recreating from local",
                spec.screen_key,
                live_block_id,
            )
            with store.locked():
                _set_screen_fields(store, spec.screen_key, live_block_id="")
            # Recursive retry with cleared block id will append a fresh one.
            return _sync_one_bidirectional(client, spec, page_id, None, store)
        log.exception(
            "could not fetch block %s for %s", live_block_id, spec.screen_key
        )
        return "error"
    except Exception:
        log.exception("unexpected error fetching block %s", live_block_id)
        return "error"

    remote_content = _extract_block_text(block)
    remote_hash = _sha256(remote_content)
    stored_entry = _screen_entry(store.get_bridge_state(), spec.screen_key) or {}
    stored_hash = stored_entry.get("live_hash")

    # No-op fast path.
    if local_hash == remote_hash == stored_hash:
        return "unchanged"

    # If both sides drifted but ended up equal, just record the new hash.
    if local_hash == remote_hash:
        with store.locked():
            _set_screen_fields(store, spec.screen_key, live_hash=local_hash)
        return "unchanged"

    local_changed = local_hash != stored_hash
    remote_changed = remote_hash != stored_hash

    if local_changed and not remote_changed:
        return _push(client, spec, live_block_id, local_content, local_hash, store)

    if remote_changed and not local_changed:
        return _pull(spec, remote_content, remote_hash, store)

    # Both changed — last-edit-wins, using our stamped local timestamp
    # against Notion's last_edited_time.
    local_stamp = _parse_notion_ts(stored_entry.get("last_local_updated_at"))
    remote_edited = _parse_notion_ts(block.get("last_edited_time"))
    if (
        local_stamp is not None
        and remote_edited is not None
        and local_stamp >= remote_edited
    ):
        log.warning(
            "%s conflict: local stamp %s >= Notion edit %s; local wins",
            spec.screen_key,
            local_stamp.isoformat(),
            remote_edited.isoformat(),
        )
        outcome = _push(client, spec, live_block_id, local_content, local_hash, store)
        return "conflict_local" if outcome == "pushed" else outcome

    log.warning(
        "%s conflict: Notion edit %s newer than local %s; remote wins",
        spec.screen_key,
        remote_edited.isoformat() if remote_edited else "<unknown>",
        local_stamp.isoformat() if local_stamp else "<unknown>",
    )
    outcome = _pull(spec, remote_content, remote_hash, store)
    return "conflict_remote" if outcome == "pulled" else outcome


def _push(
    client: NotionHTTPClient,
    spec: BidirectionalSpec,
    live_block_id: str,
    local_content: str,
    local_hash: str,
    store: RedisStore,
) -> SyncOutcome:
    payload = _code_block_payload(safe_truncate_markdown(local_content))
    try:
        client.update_block(live_block_id, payload)
    except Exception:
        log.exception("push failed for %s", spec.screen_key)
        return "error"
    with store.locked():
        _set_screen_fields(store, spec.screen_key, live_hash=local_hash)
    return "pushed"


def _pull(
    spec: BidirectionalSpec,
    remote_content: str,
    remote_hash: str,
    store: RedisStore,
) -> SyncOutcome:
    # Writing back to Redis replaces the previous atomic file write; bump
    # last_local_updated_at so the next sync cycle treats it as a local
    # edit anchored at this moment in time.
    try:
        store.set_file(spec.local_file, remote_content)
    except Exception:
        log.exception("pull-to-local Redis write failed for %s", spec.screen_key)
        return "error"
    with store.locked():
        _set_screen_fields(
            store,
            spec.screen_key,
            live_hash=remote_hash,
            last_local_updated_at=_now_iso(),
        )
    return "pulled"


# ---- Read-only sync (Docs, Visual Office) -------------------------------


def _sync_one_readonly(
    client: NotionHTTPClient,
    screen_key: str,
    page_id: str,
    live_block_id: Optional[str],
    body: str,
    store: RedisStore,
) -> SyncOutcome:
    text = safe_truncate_markdown(body)
    content_hash = _sha256(text)
    stored = (_screen_entry(store.get_bridge_state(), screen_key) or {}).get("live_hash")
    if stored == content_hash:
        return "unchanged"

    payload = _code_block_payload(text)
    if live_block_id:
        try:
            client.update_block(live_block_id, payload)
        except NotionAPIError as exc:
            if exc.status_code != 404:
                log.exception("readonly update failed for %s", screen_key)
                return "error"
            log.warning(
                "readonly block %s missing on %s; recreating",
                live_block_id,
                screen_key,
            )
            live_block_id = None
        except Exception:
            log.exception("readonly update unexpected error for %s", screen_key)
            return "error"

    if not live_block_id:
        try:
            resp = client.append_block_children(page_id, [payload])
        except Exception:
            log.exception("readonly append failed for %s", screen_key)
            return "error"
        results = (resp or {}).get("results") or []
        if not results or not isinstance(results[0], dict):
            return "error"
        new_id = results[0].get("id")
        if not new_id:
            return "error"
        with store.locked():
            _set_screen_fields(store, screen_key, live_block_id=new_id)

    with store.locked():
        _set_screen_fields(store, screen_key, live_hash=content_hash)
    return "pushed"


# ---- Public entry point --------------------------------------------------


def sync_openclaw_screens(
    client: NotionHTTPClient,
    store: RedisStore,
    warroom_path: Optional[os.PathLike | str] = None,
) -> int:
    """Bidirectional / derived sync across all six wired screen pages.

    Returns the number of screens whose Notion or local (Redis) content
    was mutated this call. Hash-matched screens skip the API entirely.

    ``warroom_path`` is accepted for backwards compatibility; all reads
    and writes flow through Redis via ``store``.
    """
    pushed = 0

    # Bidirectional file-backed screens.
    for spec in _bidirectional_specs():
        entry = _screen_entry(store.get_bridge_state(), spec.screen_key)
        if not entry or not entry.get("page_id"):
            continue
        outcome = _sync_one_bidirectional(
            client,
            spec,
            entry["page_id"],
            entry.get("live_block_id"),
            store,
        )
        if outcome in ("created", "pushed", "pulled", "conflict_local", "conflict_remote"):
            pushed += 1

    # Read-only derived screens.
    readonly_renderers: list[tuple[str, Callable[[], str]]] = [
        ("screen_docs", lambda: render_docs_screen(store)),
        ("screen_visual_office", lambda: render_visual_office(store)),
    ]
    for screen_key, renderer in readonly_renderers:
        entry = _screen_entry(store.get_bridge_state(), screen_key)
        if not entry or not entry.get("page_id"):
            continue
        try:
            body = renderer()
        except Exception:
            log.exception("renderer for %s failed; skipping", screen_key)
            continue
        outcome = _sync_one_readonly(
            client,
            screen_key,
            entry["page_id"],
            entry.get("live_block_id"),
            body,
            store,
        )
        if outcome == "pushed":
            pushed += 1

    return pushed


# ---- One-time setup hooks (still exposed for the setup script) ----------


def link_tasks_page_to_command_center(
    client: NotionHTTPClient,
    database_id: str,
    store: RedisStore,
) -> bool:
    if not database_id:
        return False
    entry = _screen_entry(store.get_bridge_state(), "screen_tasks")
    if not entry or not entry.get("page_id"):
        return False
    state = store.get_bridge_state()
    if state.get("tasks_page_linked"):
        return False
    block = {
        "object": "block",
        "type": "link_to_page",
        "link_to_page": {"type": "database_id", "database_id": database_id},
    }
    try:
        client.append_block_children(entry["page_id"], [block])
    except Exception:
        log.exception("could not link Command Center DB into Tasks page")
        return False
    with store.locked():
        new_state = store.get_bridge_state()
        new_state["tasks_page_linked"] = True
        store.set_bridge_state(new_state)
    return True


# ---- Legacy renderers kept for callers that still import them -----------
# The setup script + a few tests use these directly. The daemon uses
# `sync_openclaw_screens` which goes through the bidirectional / derived
# paths above. They now read from Redis just like the canonical renderers.


def render_memory_screen(store: RedisStore) -> str:
    return store.get_file(MEMORY_FILE) or ""


def render_calendar_screen(store: RedisStore) -> str:
    return store.get_file(SCHEDULE_FILE) or ""


def render_team_screen(store: RedisStore) -> str:
    """Legacy combined Team renderer (roster + per-agent activity).

    The daemon's bidirectional flow uses AGENT_ROLES.md raw content
    directly so user edits round-trip cleanly. The activity board now
    lives on the 🏢 Visual Office screen.
    """
    roles_text = store.get_file(ROLES_FILE) or "(no AGENT_ROLES.md yet)"
    activity = _last_activity_per_owner(store)
    if activity:
        activity_lines = ["## Per-agent last activity", ""]
        for owner in _ordered_owners(activity.keys()):
            ts = activity[owner]
            activity_lines.append(
                f"- **{owner}** — {ts or '(no recorded activity)'}"
            )
        activity_block = "\n".join(activity_lines)
    else:
        activity_block = "## Per-agent last activity\n\n(no handoff history yet)"
    return _truncate(
        f"{activity_block}\n\n## Roster (AGENT_ROLES.md)\n\n{roles_text.rstrip()}"
    )
