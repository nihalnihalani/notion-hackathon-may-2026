"""Pure-function content renderers for the Mission Control Notion page.

Path B of the storage migration moves every renderer off direct filesystem
reads and onto ``RedisStore``. Each renderer now takes a ``RedisStore``
instance and pulls the relevant logical content through the store:

- ``RedisStore.get_file(name)`` for the canonical War Room markdown files
  (``CURRENT_STATE.md``, ``SHARED_MEMORY.md``, ``SKILL_REGISTRY.md``,
  ``PROTOCOL.md``, ``AGENT_ROLES.md``).
- ``RedisStore.list_kb_docs`` / ``get_kb_doc`` for the knowledge base index.
- ``RedisStore.render_handoffs_md`` for handoff history so the renderer can
  reuse the existing ``warroom_format.parse_handoffs`` parser without
  duplicating the materialisation logic.
- ``RedisStore.get_bridge_state`` for the bridge-stats summary that used to
  read ``.notion_bridge_state.json`` off disk.

Renderers remain pure: no Notion API calls, no shell execution, no agent
CLI invocation. Missing content yields a short human-readable sentinel
rather than raising, and every renderer self-truncates to ``MAX_RENDER_LEN``
so callers don't have to.

A small back-compat shim is kept at the bottom of the module for any
legacy caller that still passes a ``Path``; tests under
``tests/test_mission_control_renderers.py`` (owned by Agent C) will be
migrated separately.
"""

from __future__ import annotations

from typing import Optional

from src.redis_store import RedisStore
from src.warroom_format import parse_handoffs, sanitize_inline


# Match `src.dashboard_sync.MAX_BLOCK_LEN` so renderers fit one code block.
MAX_RENDER_LEN = 1900

_TRUNCATE_MARKER = "\n...[truncated]"

# Stable owner ordering for `render_agent_history`. Any owners not in this
# tuple are appended after, in first-seen order, so unknown owners still
# surface but the canonical roles always come first.
_OWNER_ORDER = ("Hermes", "OpenClaw", "Codex", "User")


# ---- Internal helpers ----------------------------------------------------


def _safe_read_text(value) -> Optional[str]:
    """Back-compat shim: tolerate legacy callers that still hand us a Path.

    The migration target is "every renderer takes a ``RedisStore``", but a
    couple of helper scripts and the openclaw bidirectional syncer still
    call ``_safe_read_text`` directly with a filesystem ``Path`` to peek at
    raw War Room files. Keep that working without dragging full file I/O
    back into the renderer module by accepting both shapes here. When the
    callers migrate, this helper can be deleted.
    """
    if value is None:
        return None
    # Duck-type instead of importing pathlib at module top: any object that
    # exposes `.read_text` is treated as a Path-like.
    read_text = getattr(value, "read_text", None)
    if callable(read_text):
        try:
            return read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return None
    if isinstance(value, str):
        return value
    return None


def _truncate(text: str) -> str:
    """Cap rendered output at `MAX_RENDER_LEN`, appending a truncation marker.

    The marker length is included in the cap so the returned string is always
    `<= MAX_RENDER_LEN` characters.
    """
    if len(text) <= MAX_RENDER_LEN:
        return text
    keep = MAX_RENDER_LEN - len(_TRUNCATE_MARKER)
    if keep < 0:
        # Defensive: marker alone is longer than the cap. Just cap to the
        # marker tail.
        return _TRUNCATE_MARKER[:MAX_RENDER_LEN]
    return text[:keep] + _TRUNCATE_MARKER


# ---- Renderers -----------------------------------------------------------


def render_agent_history(store: RedisStore, *, limit_per_agent: int = 5) -> str:
    """Group recent handoff entries by Owner; show last N per agent.

    The output is a markdown document with one `## <Owner>` section per
    agent in stable order (Hermes, OpenClaw, Codex, User, then any others
    in first-seen order). Each section is a bullet list of the form
    `- [STATUS] task title (key)`.

    Missing/empty handoff index -> `(no handoff history)`.
    """
    text = store.render_handoffs_md()
    if not text or not text.strip():
        return "(no handoff history)"

    parsed = list(parse_handoffs(text))
    if not parsed:
        return "(no handoff history)"

    # Group by Owner, preserving file order. parse_handoffs yields oldest
    # first (file order), so we take the *tail* per group to satisfy the
    # "newest are last in the file" contract.
    by_owner: dict[str, list[tuple[str, dict[str, str]]]] = {}
    for key, fields in parsed:
        owner = fields.get("Owner", "").strip() or "Unknown"
        by_owner.setdefault(owner, []).append((key, fields))

    # Stable owner ordering: canonical roles first, then anything else in
    # first-seen order.
    canonical_present = [o for o in _OWNER_ORDER if o in by_owner]
    extra = [o for o in by_owner if o not in _OWNER_ORDER]
    ordered_owners = canonical_present + extra

    lines: list[str] = []
    for owner in ordered_owners:
        entries = by_owner[owner][-limit_per_agent:]
        if not entries:
            continue
        lines.append(f"## {owner}")
        for key, fields in entries:
            status = fields.get("Status", "").strip() or "UNKNOWN"
            raw_title = fields.get("Task", "")
            # Strip the embedded `[wrb_*]` key from the visible title so we
            # don't duplicate it next to the explicit `(key)` suffix.
            visible_title = raw_title.replace(f"[{key}]", "").strip()
            safe_title = sanitize_inline(visible_title, limit=200) or "(no title)"
            lines.append(f"- [{status}] {safe_title} ({key})")
        lines.append("")  # blank line between owners

    if not lines:
        return "(no handoff history)"

    # Drop trailing blank line, if any.
    while lines and lines[-1] == "":
        lines.pop()

    return _truncate("\n".join(lines))


def render_shared_memory(store: RedisStore) -> str:
    """Return SHARED_MEMORY.md contents (from Redis), truncated."""
    text = store.get_file("SHARED_MEMORY.md")
    if text is None:
        return "(no shared memory yet)"
    if not text.strip():
        return "(no shared memory yet)"
    return _truncate(text)


def render_knowledge_base_index(store: RedisStore) -> str:
    """List every KB doc registered in Redis as `- {rel_path} ({n} bytes)`.

    The previous filesystem-walk based version capped depth at two levels;
    Redis stores docs by flat relative path so we just sort the index. We
    keep the byte-count display to maintain the same visual shape on Notion
    even though the source is now a key/value store.
    """
    rel_paths = store.list_kb_docs()
    if not rel_paths:
        return "(no knowledge base files)"

    entries: list[tuple[str, int]] = []
    for rel in rel_paths:
        body = store.get_kb_doc(rel)
        if body is None:
            continue
        entries.append((rel, len(body.encode("utf-8"))))

    if not entries:
        return "(no knowledge base files)"

    entries.sort(key=lambda e: e[0])
    lines = [f"- {rel} ({size} bytes)" for rel, size in entries]
    return _truncate("\n".join(lines))


def render_skill_registry(store: RedisStore) -> str:
    """Pass-through SKILL_REGISTRY.md contents (from Redis), truncated."""
    text = store.get_file("SKILL_REGISTRY.md")
    if text is None:
        return "(no skill registry)"
    if not text.strip():
        return "(no skill registry)"
    return _truncate(text)


def render_protocol_and_roles(store: RedisStore) -> str:
    """Concatenate PROTOCOL.md and AGENT_ROLES.md with section headers.

    Either file being absent is non-fatal: that section is rendered as
    `(missing)` while the other section is still included.
    """
    protocol_text = store.get_file("PROTOCOL.md")
    roles_text = store.get_file("AGENT_ROLES.md")

    protocol_body = protocol_text.rstrip() if protocol_text else "(missing)"
    roles_body = roles_text.rstrip() if roles_text else "(missing)"

    out = (
        "## Protocol\n"
        f"{protocol_body}\n"
        "\n"
        "## Agent Roles\n"
        f"{roles_body}"
    )
    return _truncate(out)


def render_bridge_stats(store: RedisStore) -> str:
    """Summarize the bridge-state JSON blob as human-readable markdown.

    Reports:
    - number of tracked pages
    - command center data source id (or `(none)`)
    - dashboard block id (or `(none)`)
    - per-status counts of pages (based on `last_notion_status`)
    - number of mission control sections currently tracked

    Empty bridge state -> `(no bridge state yet)`.
    """
    data = store.get_bridge_state()
    if not data:
        return "(no bridge state yet)"

    pages = data.get("pages")
    if not isinstance(pages, dict):
        pages = {}

    status_counts: dict[str, int] = {}
    for entry in pages.values():
        if not isinstance(entry, dict):
            continue
        status = entry.get("last_notion_status") or "(unknown)"
        status_counts[status] = status_counts.get(status, 0) + 1

    mission_control = data.get("mission_control")
    if isinstance(mission_control, dict):
        mc_sections = len(
            [k for k in mission_control.keys() if not str(k).endswith("_hash")]
        )
        # Fall back to half of total keys if the helper hash convention isn't
        # present: every section has one id + one hash entry.
        if mc_sections == 0 and mission_control:
            mc_sections = len(mission_control) // 2 or len(mission_control)
    else:
        mc_sections = 0

    data_source_id = data.get("command_center_data_source_id") or "(none)"
    dashboard_block_id = data.get("dashboard_block_id") or "(none)"

    lines: list[str] = [
        "## Bridge State",
        f"- Tracked pages: {len(pages)}",
        f"- Command Center data source: {data_source_id}",
        f"- Dashboard block id: {dashboard_block_id}",
        f"- Mission Control sections tracked: {mc_sections}",
        "",
        "### Pages by last Notion status",
    ]
    if status_counts:
        for status in sorted(status_counts):
            lines.append(f"- {status}: {status_counts[status]}")
    else:
        lines.append("- (none)")

    return _truncate("\n".join(lines))


def render_live_state(store: RedisStore) -> str:
    """Pass-through CURRENT_STATE.md contents (from Redis), truncated."""
    text = store.get_file("CURRENT_STATE.md")
    if text is None:
        return "(no live state yet)"
    if not text.strip():
        return "(no live state yet)"
    return _truncate(text)
