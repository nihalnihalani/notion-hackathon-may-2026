"""Unit tests for `src.activity_timeline`.

The renderer is a pure file-reader, so every test uses `tmp_path` and no
mocks. The shape under test:

- Missing handoffs file -> sentinel.
- Per-agent grouping in stable order (Hermes, OpenClaw, Codex, User,
  then extras in first-seen order).
- `limit_per_agent` is per-agent, not global.
- Timestamps come from state; entries without state fall to the bottom
  in stable order; placeholder is used when state is missing.
- Title sanitization strips control characters from the rendered title.
- Output is always <= MAX_TIMELINE_CHARS even with many handoffs.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.activity_timeline import (  # noqa: E402
    MAX_TIMELINE_CHARS,
    render_activity_timeline,
)
from src.warroom_format import make_handoff_block  # noqa: E402


# ---- Shared helpers -------------------------------------------------------


def _make_handoff(
    key: str, title: str, owner: str, status: str, *, files: str = "~/x"
) -> str:
    """Build a handoff block and rewrite Status to the requested value."""
    block = make_handoff_block(
        handoff_key=key,
        title=title,
        owner=owner,
        files_touched=files,
        next_action="proceed",
        context_path="/tmp/ctx.md",
    )
    return block.replace("Status: PENDING", f"Status: {status}")


def _write_handoffs(tmp_path: Path, blocks: list[str]) -> Path:
    handoffs = tmp_path / "HANDOFFS.md"
    handoffs.write_text("\n".join(blocks), encoding="utf-8")
    return handoffs


def _write_state(tmp_path: Path, pages: dict) -> Path:
    state = {"version": 1, "pages": pages}
    state_path = tmp_path / ".notion_bridge_state.json"
    state_path.write_text(json.dumps(state), encoding="utf-8")
    return state_path


# ---- Missing files -------------------------------------------------------


def test_missing_handoffs_returns_sentinel(tmp_path: Path) -> None:
    out = render_activity_timeline(
        tmp_path / "missing.md", tmp_path / "state.json"
    )
    assert out == "(no agent activity yet)"


def test_empty_handoffs_returns_sentinel(tmp_path: Path) -> None:
    handoffs = tmp_path / "HANDOFFS.md"
    handoffs.write_text("", encoding="utf-8")
    out = render_activity_timeline(handoffs, tmp_path / "state.json")
    assert out == "(no agent activity yet)"


def test_missing_state_still_renders_with_placeholder(tmp_path: Path) -> None:
    handoffs = _write_handoffs(
        tmp_path,
        [_make_handoff("wrb_aaaaaaaaaaaa", "task one", "Hermes", "COMPLETED")],
    )
    out = render_activity_timeline(handoffs, tmp_path / "no_such_state.json")
    assert "### Hermes" in out
    assert "task one" in out
    assert "wrb_aaaaaaaaaaaa" in out
    # Placeholder timestamp.
    assert "----------------- UTC" in out


# ---- Per-agent grouping ---------------------------------------------------


def test_per_agent_groups_in_stable_order(tmp_path: Path) -> None:
    blocks = [
        _make_handoff("wrb_aaaaaaaaaaaa", "h1", "Hermes", "COMPLETED"),
        _make_handoff("wrb_bbbbbbbbbbbb", "oc1", "OpenClaw", "IN PROGRESS"),
        _make_handoff("wrb_cccccccccccc", "cx1", "Codex", "BLOCKED"),
        _make_handoff("wrb_dddddddddddd", "u1", "User", "PENDING"),
        _make_handoff("wrb_eeeeeeeeeeee", "rb1", "Robot", "PENDING"),
    ]
    handoffs = _write_handoffs(tmp_path, blocks)
    state_path = _write_state(tmp_path, {})

    out = render_activity_timeline(handoffs, state_path)

    for section in ("### Hermes", "### OpenClaw", "### Codex", "### User", "### Robot"):
        assert section in out
    # Canonical order, extras at the end.
    assert (
        out.index("### Hermes")
        < out.index("### OpenClaw")
        < out.index("### Codex")
        < out.index("### User")
        < out.index("### Robot")
    )


def test_limit_per_agent_is_per_agent_not_global(tmp_path: Path) -> None:
    blocks: list[str] = []
    # 6 Hermes tasks, 4 OpenClaw tasks. limit_per_agent=3 -> 3 + 3 lines.
    for i in range(6):
        blocks.append(
            _make_handoff(
                f"wrb_aaa{i:09x}", f"H job {i}", "Hermes", "COMPLETED"
            )
        )
    for i in range(4):
        blocks.append(
            _make_handoff(
                f"wrb_bbb{i:09x}", f"OC job {i}", "OpenClaw", "PENDING"
            )
        )
    handoffs = _write_handoffs(tmp_path, blocks)
    state_path = _write_state(tmp_path, {})

    out = render_activity_timeline(handoffs, state_path, limit_per_agent=3)

    hermes_section = out.split("### Hermes", 1)[1].split("### ", 1)[0]
    hermes_bullets = [
        ln for ln in hermes_section.splitlines() if ln.startswith("- ")
    ]
    assert len(hermes_bullets) == 3

    openclaw_section = out.split("### OpenClaw", 1)[1]
    openclaw_bullets = [
        ln for ln in openclaw_section.splitlines() if ln.startswith("- ")
    ]
    assert len(openclaw_bullets) == 3


# ---- Timestamp behavior ---------------------------------------------------


def test_entries_sort_newest_first_by_timestamp(tmp_path: Path) -> None:
    blocks = [
        _make_handoff("wrb_111111111111", "old task", "Hermes", "COMPLETED"),
        _make_handoff("wrb_222222222222", "new task", "Hermes", "COMPLETED"),
        _make_handoff("wrb_333333333333", "mid task", "Hermes", "COMPLETED"),
    ]
    handoffs = _write_handoffs(tmp_path, blocks)
    state_path = _write_state(
        tmp_path,
        {
            "page-A": {
                "handoff_key": "wrb_111111111111",
                "last_synced_at": "2026-05-17T08:00:00Z",
            },
            "page-B": {
                "handoff_key": "wrb_222222222222",
                "last_synced_at": "2026-05-17T15:30:00Z",
            },
            "page-C": {
                "handoff_key": "wrb_333333333333",
                "last_synced_at": "2026-05-17T12:00:00Z",
            },
        },
    )

    out = render_activity_timeline(handoffs, state_path, limit_per_agent=10)
    hermes_section = out.split("### Hermes", 1)[1]

    # Newest entry first.
    new_idx = hermes_section.index("new task")
    mid_idx = hermes_section.index("mid task")
    old_idx = hermes_section.index("old task")
    assert new_idx < mid_idx < old_idx

    # Formatted timestamps appear.
    assert "2026-05-17 15:30 UTC" in hermes_section
    assert "2026-05-17 12:00 UTC" in hermes_section
    assert "2026-05-17 08:00 UTC" in hermes_section


def test_untimestamped_entries_sink_to_bottom_in_stable_order(
    tmp_path: Path,
) -> None:
    blocks = [
        _make_handoff("wrb_aaaaaaaaaaaa", "no ts A", "Hermes", "COMPLETED"),
        _make_handoff("wrb_bbbbbbbbbbbb", "has ts", "Hermes", "COMPLETED"),
        _make_handoff("wrb_cccccccccccc", "no ts B", "Hermes", "COMPLETED"),
    ]
    handoffs = _write_handoffs(tmp_path, blocks)
    state_path = _write_state(
        tmp_path,
        {
            "page-B": {
                "handoff_key": "wrb_bbbbbbbbbbbb",
                "last_synced_at": "2026-05-17T10:00:00Z",
            }
        },
    )

    out = render_activity_timeline(handoffs, state_path, limit_per_agent=10)
    hermes_section = out.split("### Hermes", 1)[1]

    ts_idx = hermes_section.index("has ts")
    no_a_idx = hermes_section.index("no ts A")
    no_b_idx = hermes_section.index("no ts B")

    # Timestamped first, then untimestamped in original file order (A then B).
    assert ts_idx < no_a_idx < no_b_idx

    # Untimestamped lines render with the placeholder.
    placeholder = "----------------- UTC"
    assert placeholder in hermes_section


# ---- Sanitization ---------------------------------------------------------


def test_title_sanitization_strips_control_chars(tmp_path: Path) -> None:
    blocks = [
        _make_handoff(
            "wrb_aaaaaaaaaaaa",
            "evil\x00title\x1bhere",
            "Hermes",
            "COMPLETED",
        ),
    ]
    handoffs = _write_handoffs(tmp_path, blocks)
    state_path = _write_state(tmp_path, {})

    out = render_activity_timeline(handoffs, state_path)
    assert "\x00" not in out
    assert "\x1b" not in out
    assert "eviltitlehere" in out or "evil title here" in out


# ---- Truncation ----------------------------------------------------------


def test_truncates_when_many_handoffs(tmp_path: Path) -> None:
    blocks = [
        _make_handoff(
            f"wrb_{i:012x}",
            "x" * 180,  # long titles
            "Hermes",
            "COMPLETED",
        )
        for i in range(80)
    ]
    handoffs = _write_handoffs(tmp_path, blocks)
    state_path = _write_state(tmp_path, {})

    out = render_activity_timeline(handoffs, state_path, limit_per_agent=80)
    assert len(out) <= MAX_TIMELINE_CHARS
    assert out.endswith("...[truncated]")
