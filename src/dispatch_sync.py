"""Dispatch sync: copy Notion `Pending` tasks into the War Room handoff queue.

This module is the Redis-backed rewrite of the dispatch flow (Path B of the
storage migration). The previous file-based implementation appended to
`HANDOFFS.md` on disk and stored bridge state in
`.notion_bridge_state.json`. It now:

- writes each new handoff into Redis via ``RedisStore.upsert_handoff`` —
  ``HANDOFFS.md`` is materialised on demand from that index by
  ``RedisStore.render_handoffs_md`` for any consumer that still wants the
  on-disk format (the local-file mirror process owns that path).
- writes the full Notion context snapshot via ``RedisStore.set_notion_inbox``
  rather than to ``NotionInbox/<key>.md`` on disk.
- reads/writes bridge state JSON via
  ``RedisStore.get_bridge_state`` / ``set_bridge_state``.
- holds the per-cycle critical section via ``RedisStore.locked``
  (the SETNX-fenced Redis lock that replaces the old ``FileLock``).

Public signature is preserved: callers still call
``sync_dispatch(client, data_source_id, warroom_path, store=redis_store)``
so the daemon and any helper scripts continue to work after passing a
``RedisStore`` instead of the legacy ``StateStore``. The ``warroom_path``
argument is kept for compatibility but is no longer consulted — Redis owns
the storage now.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from src.notion_http import NotionHTTPClient
from src.redis_store import RedisStore
from src.state_store import handoff_key_for_page
from src.warroom_format import (
    ALLOWED_OWNERS,
    PLANNING_FILES_DEFAULT,
    make_handoff_block,
    sanitize_multiline,
    sanitize_path_field,
    sanitize_text_field,
)

log = logging.getLogger(__name__)


HANDOFFS_NAME = "HANDOFFS.md"
CURRENT_STATE_NAME = "CURRENT_STATE.md"

_PENDING_QUERY: dict[str, Any] = {
    "filter": {"property": "Status", "status": {"equals": "Pending"}},
    "page_size": 50,
}


def rate_limit_sleep() -> None:
    """Legacy pacing helper retained for callers still on the raw client."""
    time.sleep(0.4)


# ---- Notion property unwrappers --------------------------------------------


def _rich_text(prop: Optional[Mapping[str, Any]]) -> str:
    if not prop:
        return ""
    parts = prop.get("rich_text") or []
    return "".join((p.get("text") or {}).get("content", "") for p in parts).strip()


def _title(prop: Optional[Mapping[str, Any]]) -> str:
    if not prop:
        return ""
    parts = prop.get("title") or []
    return "".join((p.get("text") or {}).get("content", "") for p in parts).strip()


def _select_name(prop: Optional[Mapping[str, Any]]) -> Optional[str]:
    if not prop:
        return None
    sel = prop.get("select")
    if not sel:
        return None
    return sel.get("name")


# ---- Helpers ----------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sync_hash(*parts: str) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update((p or "").encode("utf-8"))
        h.update(b"\0")
    return h.hexdigest()


def _active_locks_text(store: RedisStore) -> str:
    """Pull the "## Active Locks" section out of the Redis-backed CURRENT_STATE.

    Returns an empty string when the file isn't present or has no Active Locks
    section. Same parsing rules as the file-based version so the conflict
    detection contract from plan.md §6.A is preserved.
    """
    raw = store.get_file(CURRENT_STATE_NAME)
    if not raw:
        return ""
    section_re = re.compile(
        r"^##\s*Active Locks\s*\n(.*?)(?=^##\s|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = section_re.search(raw)
    return match.group(1) if match else ""


def _files_touched_tokens(files_touched: str) -> list[str]:
    if not files_touched:
        return []
    tokens = re.split(r"[\s,;]+", files_touched.strip())
    return [t for t in tokens if t and t not in {".", "/"}]


def _detect_lock_conflict(files_touched: str, locks_text: str) -> Optional[str]:
    if not files_touched or not locks_text:
        return None
    for token in _files_touched_tokens(files_touched):
        if token in locks_text:
            return token
    return None


def _build_context_snapshot(
    handoff_key: str,
    page_id: str,
    *,
    title: str,
    owner: str,
    files_touched: str,
    context: str,
    work_dir: str,
    next_action: str,
) -> str:
    """Render the Notion context snapshot body that goes into Redis.

    Same shape the file-based version wrote to ``NotionInbox/<key>.md`` so
    any downstream consumer (or the local-file mirror that materialises
    those files) gets identical text.
    """
    return (
        f"# Notion Task Snapshot — {handoff_key}\n\n"
        f"- Notion page id: {page_id}\n"
        f"- Title: {sanitize_text_field(title)}\n"
        f"- Owner: {owner}\n"
        f"- Authorized Files: {sanitize_path_field(files_touched)}\n"
        f"- Working Directory: {sanitize_path_field(work_dir)}\n"
        f"- Next Action: {sanitize_text_field(next_action)}\n\n"
        "## Context\n\n"
        f"{sanitize_multiline(context)}\n"
    )


def _props_dispatched(handoff_key: str, when: str, sync_hash: str) -> dict[str, Any]:
    return {
        "Status": {"status": {"name": "Dispatched"}},
        "War Room Key": {
            "rich_text": [{"type": "text", "text": {"content": handoff_key}}]
        },
        "Last Synced At": {"date": {"start": when}},
        "Last Sync Hash": {
            "rich_text": [{"type": "text", "text": {"content": sync_hash}}]
        },
    }


def _props_blocked(reason: str, when: str, sync_hash: str) -> dict[str, Any]:
    return {
        "Status": {"status": {"name": "Blocked"}},
        "Result Summary": {
            "rich_text": [
                {"type": "text", "text": {"content": sanitize_text_field(reason)}}
            ]
        },
        "Last Synced At": {"date": {"start": when}},
        "Last Sync Hash": {
            "rich_text": [{"type": "text", "text": {"content": sync_hash}}]
        },
    }


# ---- Bridge-state helpers (replaces StateStore.mark_dispatched) -------------


def _record_dispatched(
    store: RedisStore,
    *,
    page_id: str,
    handoff_key: str,
    context_key: Optional[str],
    last_notion_status: str,
    last_local_status: str,
    last_synced_at: str,
    last_sync_hash: str,
) -> None:
    """Idempotently insert the page entry into the bridge state JSON blob.

    Mirrors what ``StateStore.mark_dispatched`` used to do on the file-backed
    sidecar so the bridge state shape (per plan.md §5) is unchanged. The
    caller must already hold ``store.locked()`` for the surrounding critical
    section.
    """
    state = store.get_bridge_state()
    pages = state.setdefault("pages", {})
    if not isinstance(pages, dict):
        pages = {}
        state["pages"] = pages
    existing = pages.get(page_id) or {}
    entry: dict[str, Any] = dict(existing) if isinstance(existing, Mapping) else {}
    entry["handoff_key"] = handoff_key
    if context_key is not None:
        # Stored as a Redis key reference (`wr:notion_inbox:<handoff_key>`) so
        # downstream tooling can fetch the body without re-deriving it; kept
        # under the same JSON field name for plan.md §5 compatibility.
        entry["context_path"] = context_key
    else:
        entry.setdefault("context_path", None)
    entry["last_notion_status"] = last_notion_status
    entry["last_local_status"] = last_local_status
    entry["last_synced_at"] = last_synced_at
    entry["last_sync_hash"] = last_sync_hash
    entry.setdefault("last_result_hash", None)
    entry.setdefault("last_next_action_hash", None)
    entry.setdefault("last_result_block_id", None)
    pages[page_id] = entry
    store.set_bridge_state(state)


# ---- Public entry point -----------------------------------------------------


def sync_dispatch(
    client: NotionHTTPClient,
    data_source_id: str,
    warroom_path: Optional[os.PathLike | str] = None,
    *,
    store: Optional[RedisStore] = None,
    query_payload: Optional[Mapping[str, Any]] = None,
) -> int:
    """Dispatch new Notion `Pending` tasks into the War Room handoff queue.

    Returns the count of pages this call newly resolved (dispatched OR blocked).
    Pages already present in state are left untouched so the bridge stays
    idempotent across restarts.

    ``warroom_path`` is kept as an optional positional for back-compat with
    older callers (e.g. the daemon prior to the Redis migration); all storage
    now flows through Redis via ``store``. Pass it or omit it freely.
    """
    if not data_source_id:
        raise ValueError("data_source_id is required")
    if store is None:
        # Constructed from REDIS_URL; raises RedisStoreError if absent so the
        # daemon fails loudly instead of silently degrading to local files.
        store = RedisStore()

    payload = dict(query_payload or _PENDING_QUERY)
    response = client.query_data_source(data_source_id, payload)
    pages = response.get("results") or []
    resolved = 0

    locks_text = _active_locks_text(store)

    for page in pages:
        page_id = page.get("id")
        if not page_id:
            continue
        props = page.get("properties") or {}
        title = _title(props.get("Name"))
        owner = _select_name(props.get("Assignee"))
        files_touched = _rich_text(
            props.get("Authorized Files") or props.get("Files Touched")
        )
        context = _rich_text(props.get("Context"))
        work_dir = _rich_text(props.get("Working Directory"))
        next_action = _rich_text(props.get("Next Action"))

        handoff_key = handoff_key_for_page(page_id)
        when = _now_iso()
        sync_hash = _sync_hash(
            title, owner or "", files_touched, context, next_action
        )

        with store.locked():
            state = store.get_bridge_state()
            if page_id in (state.get("pages") or {}):
                continue

            if owner not in ALLOWED_OWNERS:
                reason = (
                    f"Invalid Assignee {owner!r}; must be one of "
                    f"{', '.join(ALLOWED_OWNERS)}."
                )
                _record_dispatched(
                    store,
                    page_id=page_id,
                    handoff_key=handoff_key,
                    context_key=None,
                    last_notion_status="Blocked",
                    last_local_status="BLOCKED",
                    last_synced_at=when,
                    last_sync_hash=sync_hash,
                )
                # Blocked tasks do NOT enter the handoff log — only the
                # Notion card is updated with the rejection reason. This
                # matches plan.md §6.A behaviour ("invalid owner → Notion
                # Blocked") and keeps `render_handoffs_md()` clean of
                # rejected entries that an agent would otherwise pick up.
                try:
                    client.update_page(page_id, _props_blocked(reason, when, sync_hash))
                except Exception:
                    log.exception("could not mark %s blocked in Notion", page_id)
                resolved += 1
                continue

            effective_files = files_touched or PLANNING_FILES_DEFAULT
            conflict = _detect_lock_conflict(effective_files, locks_text)
            if conflict:
                reason = (
                    f"Active lock conflict on {conflict!r}; release the lock in "
                    f"CURRENT_STATE.md before retrying."
                )
                _record_dispatched(
                    store,
                    page_id=page_id,
                    handoff_key=handoff_key,
                    context_key=None,
                    last_notion_status="Blocked",
                    last_local_status="BLOCKED",
                    last_synced_at=when,
                    last_sync_hash=sync_hash,
                )
                # Same rule as invalid-owner: blocked tasks stay out of the
                # handoff log; only the Notion card carries the reason.
                try:
                    client.update_page(page_id, _props_blocked(reason, when, sync_hash))
                except Exception:
                    log.exception("could not mark %s blocked in Notion", page_id)
                resolved += 1
                continue

            # Stash the full Notion context as a snapshot blob in Redis.
            snapshot_body = _build_context_snapshot(
                handoff_key,
                page_id,
                title=title,
                owner=owner,
                files_touched=effective_files,
                context=context,
                work_dir=work_dir,
                next_action=next_action,
            )
            store.set_notion_inbox(handoff_key, snapshot_body)

            # The Redis handoff store *is* the new authoritative HANDOFFS.md.
            # We still render the protocol entry (via make_handoff_block) so
            # we can derive the same sanitized text for `Task` / `Files
            # Touched` / `Next Action` fields — then split it into the
            # structured fields the Redis store expects.
            entry_text = make_handoff_block(
                handoff_key=handoff_key,
                title=title,
                owner=owner,
                files_touched=effective_files,
                next_action=next_action,
                context_path=f"redis://wr:notion_inbox:{handoff_key}",
            )
            fields = _split_handoff_entry(entry_text)
            store.upsert_handoff(
                handoff_key,
                task=fields.get("Task", f"{title} [{handoff_key}]"),
                owner=fields.get("Owner", owner),
                files_touched=fields.get("Files Touched", effective_files),
                status="PENDING",
                result="",
                next_action=fields.get("Next Action", ""),
                context=f"Notion page id: {page_id}",
            )

            _record_dispatched(
                store,
                page_id=page_id,
                handoff_key=handoff_key,
                context_key=f"wr:notion_inbox:{handoff_key}",
                last_notion_status="Dispatched",
                last_local_status="PENDING",
                last_synced_at=when,
                last_sync_hash=sync_hash,
            )

            try:
                client.update_page(
                    page_id, _props_dispatched(handoff_key, when, sync_hash)
                )
            except Exception:
                log.exception(
                    "Notion dispatched-update failed for %s; will retry on next "
                    "sync cycle from local state",
                    page_id,
                )

            resolved += 1

    return resolved


# ---- Internal: split a rendered protocol block into its six fields ---------


_FIELD_LINE_RE = re.compile(
    r"^\s*(?:-\s+)?(Task|Owner|Files Touched|Status|Result|Next Action)\s*:\s*(.*)$"
)


def _split_handoff_entry(entry_text: str) -> dict[str, str]:
    """Parse one make_handoff_block() output into a {field: value} dict.

    Used to feed the sanitized field values from the canonical renderer into
    the Redis hash. We intentionally do not re-use ``warroom_format.parse_handoffs``
    because that helper drops blocks lacking a ``[wrb_*]`` key, and we want
    the raw per-field values regardless of key presence.
    """
    fields: dict[str, str] = {}
    last_key: Optional[str] = None
    for raw_line in entry_text.splitlines():
        m = _FIELD_LINE_RE.match(raw_line)
        if m:
            last_key = m.group(1)
            fields[last_key] = m.group(2).strip()
        elif last_key and raw_line.strip():
            fields[last_key] = (fields[last_key] + " " + raw_line.strip()).strip()
    return fields
