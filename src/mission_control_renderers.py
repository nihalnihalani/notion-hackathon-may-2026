"""Pure-function content renderers for the Mission Control Notion page.

Each renderer takes one or more local War Room file paths and returns a
markdown string ready to be pushed into a single Notion code block by the
mission control syncer. Renderers do NOT:

- call the Notion API,
- invoke external processes, shells, or agent CLIs,
- read directories outside the supplied paths.

They are pure file readers: missing files yield a short human-readable
sentinel rather than raising, and every renderer self-truncates to
`MAX_RENDER_LEN` so the caller does not have to.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from src.warroom_format import parse_handoffs, sanitize_inline


# Match `src.dashboard_sync.MAX_BLOCK_LEN` so renderers fit one code block.
MAX_RENDER_LEN = 1900

_TRUNCATE_MARKER = "\n...[truncated]"

# Stable owner ordering for `render_agent_history`. Any owners not in this
# tuple are appended after, in first-seen order, so unknown owners still
# surface but the canonical roles always come first.
_OWNER_ORDER = ("Hermes", "OpenClaw", "Codex", "User")


# ---- Internal helpers ----------------------------------------------------


def _safe_read_text(path: Path) -> Optional[str]:
    """Return UTF-8 text from `path`, or None on missing/IO error.

    We deliberately swallow `OSError` (which covers `FileNotFoundError`,
    `PermissionError`, `IsADirectoryError`, etc.) so a single broken file
    cannot crash the daemon's render cycle.
    """
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
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


def render_agent_history(
    handoffs_path: Path, *, limit_per_agent: int = 5
) -> str:
    """Group recent handoff entries by Owner; show last N per agent.

    The output is a markdown document with one `## <Owner>` section per
    agent in stable order (Hermes, OpenClaw, Codex, User, then any others
    in first-seen order). Each section is a bullet list of the form
    `- [STATUS] task title (key)`.

    Missing/empty source -> `(no handoff history)`.
    """
    text = _safe_read_text(handoffs_path)
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


def render_shared_memory(memory_path: Path) -> str:
    """Return SHARED_MEMORY.md contents, truncated."""
    text = _safe_read_text(memory_path)
    if text is None:
        return "(no shared memory yet)"
    if not text.strip():
        return "(no shared memory yet)"
    return _truncate(text)


def render_knowledge_base_index(kb_dir: Path) -> str:
    """List every `.md` file under `kb_dir` (max two levels deep) as bullets.

    Format per entry: `- {relative_path} ({n} bytes)`. Entries are sorted
    by relative path. Non-`.md` files are ignored. Missing or non-directory
    `kb_dir` -> `(no knowledge base files)`.
    """
    try:
        if not kb_dir.exists() or not kb_dir.is_dir():
            return "(no knowledge base files)"
    except OSError:
        return "(no knowledge base files)"

    entries: list[tuple[str, int]] = []
    # Depth 0: kb_dir itself; depth 1: kb_dir/*; depth 2: kb_dir/*/*.
    # `relative_to(kb_dir).parts` gives 1 for top-level files, 2 for
    # one-level-nested files. Anything deeper is skipped.
    try:
        candidates = list(kb_dir.rglob("*.md"))
    except OSError:
        return "(no knowledge base files)"

    for path in candidates:
        try:
            rel = path.relative_to(kb_dir)
        except ValueError:
            continue
        if len(rel.parts) > 2:
            continue
        try:
            if not path.is_file():
                continue
            size = path.stat().st_size
        except OSError:
            continue
        entries.append((str(rel), size))

    if not entries:
        return "(no knowledge base files)"

    entries.sort(key=lambda e: e[0])
    lines = [f"- {rel} ({size} bytes)" for rel, size in entries]
    return _truncate("\n".join(lines))


def render_skill_registry(registry_path: Path) -> str:
    """Pass-through SKILL_REGISTRY.md contents, truncated."""
    text = _safe_read_text(registry_path)
    if text is None:
        return "(no skill registry)"
    if not text.strip():
        return "(no skill registry)"
    return _truncate(text)


def render_protocol_and_roles(protocol_path: Path, roles_path: Path) -> str:
    """Concatenate PROTOCOL.md and AGENT_ROLES.md with section headers.

    Either file being absent is non-fatal: that section is rendered as
    `(missing)` while the other section is still included.
    """
    protocol_text = _safe_read_text(protocol_path)
    roles_text = _safe_read_text(roles_path)

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


def render_bridge_stats(state_path: Path) -> str:
    """Summarize `.notion_bridge_state.json` as human-readable markdown.

    Reports:
    - number of tracked pages
    - command center data source id (or `(none)`)
    - dashboard block id (or `(none)`)
    - per-status counts of pages (based on `last_notion_status`)
    - number of mission control sections currently tracked

    Missing file -> `(no bridge state yet)`.
    Malformed JSON -> `(bridge state unreadable)`.
    """
    raw = _safe_read_text(state_path)
    if raw is None:
        return "(no bridge state yet)"
    if not raw.strip():
        return "(no bridge state yet)"
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return "(bridge state unreadable)"
    if not isinstance(data, dict):
        return "(bridge state unreadable)"

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

def render_live_state(state_path: Path) -> str:
    """Pass-through CURRENT_STATE.md contents, truncated."""
    text = _safe_read_text(state_path)
    if text is None:
        return "(no live state yet)"
    if not text.strip():
        return "(no live state yet)"
    return _truncate(text)
