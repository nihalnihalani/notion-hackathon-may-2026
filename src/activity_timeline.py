"""Per-agent activity timeline renderer.

Companion to `src.mission_control_renderers`. This renderer reads two
local files and emits a markdown timeline keyed by agent owner, with each
entry timestamped from `.notion_bridge_state.json`:

```
### Hermes
- 2026-05-17 12:34 UTC  [COMPLETED] task title (wrb_xxx)
- 2026-05-17 11:22 UTC  [IN PROGRESS] another title (wrb_yyy)
```

Like the rest of the renderer family this module is a pure function: no
network I/O, no shell execution, no Notion SDK usage, and it silently
substitutes a placeholder timestamp rather than crashing when state is
missing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Optional

from src.warroom_format import parse_handoffs, sanitize_inline


MAX_TIMELINE_CHARS = 1900

_TRUNCATE_MARKER = "...[truncated]"
_TIMESTAMP_PLACEHOLDER = "----------------- UTC"

# Stable owner order, matching `src.mission_control_renderers._OWNER_ORDER`.
_OWNER_ORDER = ("Hermes", "OpenClaw", "Codex", "User")


# ---- Internal helpers ----------------------------------------------------


def _safe_read_text(path: Path) -> Optional[str]:
    """Read UTF-8 text from `path`; return None on missing or IO error."""
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _load_state(state_path: Path) -> Mapping[str, Any]:
    """Load `.notion_bridge_state.json` defensively.

    Missing file, unreadable file, or malformed JSON all collapse to an
    empty mapping so callers can render placeholder timestamps instead of
    crashing the daemon render cycle.
    """
    raw = _safe_read_text(state_path)
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def _timestamps_by_key(state: Mapping[str, Any]) -> dict[str, Optional[str]]:
    """Map handoff key -> `last_synced_at` (or None) from state."""
    pages = state.get("pages") if isinstance(state, Mapping) else None
    if not isinstance(pages, Mapping):
        return {}
    result: dict[str, Optional[str]] = {}
    for _page_id, entry in pages.items():
        if not isinstance(entry, Mapping):
            continue
        key = entry.get("handoff_key")
        if not isinstance(key, str) or not key:
            continue
        ts = entry.get("last_synced_at")
        result[key] = ts if isinstance(ts, str) and ts else None
    return result


def _format_timestamp(iso: Optional[str]) -> str:
    """Render an ISO 8601 UTC timestamp as `YYYY-MM-DD HH:MM UTC`.

    State stores timestamps as ISO 8601 strings (e.g. ``2026-05-17T12:34:56Z``
    or ``2026-05-17T12:34:56+00:00``). We accept either suffix without
    pulling in a real parser, because the bridge always writes UTC anyway.
    Anything we cannot parse falls back to the placeholder so a corrupt
    state file never crashes the renderer.
    """
    if not iso:
        return _TIMESTAMP_PLACEHOLDER
    # Tolerate both `Z` and `+00:00` suffixes; we display UTC unconditionally.
    text = iso.strip()
    if "T" not in text or len(text) < 16:
        return _TIMESTAMP_PLACEHOLDER
    date_part, _, time_part = text.partition("T")
    # Strip timezone designator: 'Z', '+00:00', '-05:30', etc.
    for sep in ("Z", "+", "-"):
        if sep in time_part:
            time_part = time_part.split(sep, 1)[0]
            break
    # time_part should now look like HH:MM:SS or HH:MM:SS.fff
    hhmm = time_part[:5]
    if len(hhmm) < 5 or hhmm[2] != ":":
        return _TIMESTAMP_PLACEHOLDER
    if len(date_part) != 10 or date_part[4] != "-" or date_part[7] != "-":
        return _TIMESTAMP_PLACEHOLDER
    return f"{date_part} {hhmm} UTC"


def _sort_key(timestamp: Optional[str], original_index: int) -> tuple:
    """Sort key: timestamps descending, then untimestamped in stable order.

    Python sorts ascending, so to get newest-first we negate by using a
    tuple of (has_no_timestamp, -descending_score, original_index). Entries
    without timestamps land last in first-seen order.
    """
    if timestamp:
        # Lexicographic comparison works on ISO 8601 UTC timestamps.
        # Negate by wrapping into a tuple (0, inverted-key) so timestamped
        # entries always sort before untimestamped ones.
        return (0, _NegatedString(timestamp), original_index)
    return (1, _NegatedString(""), original_index)


class _NegatedString:
    """Helper that inverts string ordering so descending sort works."""

    __slots__ = ("value",)

    def __init__(self, value: str) -> None:
        self.value = value

    def __lt__(self, other: "_NegatedString") -> bool:
        return self.value > other.value

    def __eq__(self, other: object) -> bool:
        return isinstance(other, _NegatedString) and self.value == other.value


def _truncate(text: str) -> str:
    """Cap at MAX_TIMELINE_CHARS with a trailing `...[truncated]` marker."""
    if len(text) <= MAX_TIMELINE_CHARS:
        return text
    keep = MAX_TIMELINE_CHARS - len(_TRUNCATE_MARKER)
    if keep < 0:
        return _TRUNCATE_MARKER[:MAX_TIMELINE_CHARS]
    return text[:keep] + _TRUNCATE_MARKER


# ---- Public renderer ----------------------------------------------------


def render_activity_timeline(
    handoffs_path: Path,
    state_path: Path,
    *,
    limit_per_agent: int = 5,
) -> str:
    """Render a per-agent activity timeline with timestamps from state.

    See module docstring for the output shape. Returns
    ``"(no agent activity yet)"`` when the handoffs file is missing or
    empty. When the state file is missing the timeline is still rendered
    but every timestamp is replaced with a placeholder.
    """
    text = _safe_read_text(handoffs_path)
    if not text or not text.strip():
        return "(no agent activity yet)"

    parsed = list(parse_handoffs(text))
    if not parsed:
        return "(no agent activity yet)"

    state = _load_state(state_path)
    ts_by_key = _timestamps_by_key(state)

    # Group by owner, preserving file order so untimestamped entries stay
    # stable. We capture the original index for stable sorting.
    by_owner: dict[str, list[tuple[int, str, dict[str, str], Optional[str]]]] = {}
    for idx, (key, fields) in enumerate(parsed):
        owner = (fields.get("Owner", "") or "").strip() or "Unknown"
        timestamp = ts_by_key.get(key)
        by_owner.setdefault(owner, []).append((idx, key, fields, timestamp))

    # Canonical owners first, then any extras in first-seen order.
    canonical_present = [o for o in _OWNER_ORDER if o in by_owner]
    extras = [o for o in by_owner if o not in _OWNER_ORDER]
    ordered_owners = canonical_present + extras

    lines: list[str] = []
    for owner in ordered_owners:
        entries = by_owner[owner]
        # Sort newest first; untimestamped sink to the bottom in stable order.
        entries_sorted = sorted(
            entries,
            key=lambda e: _sort_key(e[3], e[0]),
        )
        trimmed = entries_sorted[:limit_per_agent]
        if not trimmed:
            continue
        lines.append(f"### {owner}")
        for _idx, key, fields, timestamp in trimmed:
            status = (fields.get("Status", "") or "").strip() or "UNKNOWN"
            raw_title = fields.get("Task", "") or ""
            # Strip the embedded `[wrb_*]` key from the visible title since
            # it appears again in the `(key)` suffix.
            visible_title = raw_title.replace(f"[{key}]", "").strip()
            safe_title = sanitize_inline(visible_title, limit=200) or "(no title)"
            ts_str = _format_timestamp(timestamp)
            lines.append(
                f"- {ts_str}  [{status}] {safe_title} ({key})"
            )
        lines.append("")  # blank line between owner blocks

    # Drop trailing blank line, if any.
    while lines and lines[-1] == "":
        lines.pop()

    if not lines:
        return "(no agent activity yet)"

    return _truncate("\n".join(lines))
