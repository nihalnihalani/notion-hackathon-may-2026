"""Unit tests for `src.activity_timeline` — Redis-backed.

The renderer reads handoffs and bridge state from a `RedisStore`. Every
test seeds the store via the standard `store` fixture and passes it to
`render_activity_timeline`.

Contract under test:
- No handoffs returns the sentinel.
- Per-agent grouping in stable order (Hermes, OpenClaw, Codex, User,
  then extras in first-seen order).
- `limit_per_agent` is per-agent, not global.
- Timestamps come from bridge state; entries without state fall to the
  bottom in stable order; placeholder is used when state is missing.
- Title sanitization strips control characters.
- Output is always <= MAX_TIMELINE_CHARS even with many handoffs.
"""

from __future__ import annotations

import sys
from pathlib import Path

import fakeredis
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.activity_timeline import (  # noqa: E402
    MAX_TIMELINE_CHARS,
    render_activity_timeline,
)
from src.redis_store import RedisStore  # noqa: E402


@pytest.fixture
def store() -> RedisStore:
    return RedisStore(client=fakeredis.FakeRedis(decode_responses=True))


# ---- Shared helpers -------------------------------------------------------


def _seed_handoff(
    store: RedisStore,
    key: str,
    title: str,
    owner: str,
    status: str,
    *,
    files: str = "~/x",
) -> None:
    store.upsert_handoff(
        key,
        task=title,
        owner=owner,
        files_touched=files,
        status=status,
        next_action="proceed",
    )


def _set_pages(store: RedisStore, pages: dict) -> None:
    state = store.get_bridge_state()
    state["pages"] = pages
    store.set_bridge_state(state)


# ---- Missing data --------------------------------------------------------


def test_no_handoffs_returns_sentinel(store) -> None:
    out = render_activity_timeline(store)
    assert out == "(no agent activity yet)"


def test_missing_state_still_renders_with_placeholder(store) -> None:
    _seed_handoff(store, "wrb_aaaaaaaaaaaa", "task one", "Hermes", "COMPLETED")
    # No bridge-state pages mapping — no timestamps.
    out = render_activity_timeline(store)
    assert "### Hermes" in out
    assert "task one" in out
    assert "wrb_aaaaaaaaaaaa" in out
    # Placeholder timestamp.
    assert "----------------- UTC" in out


# ---- Per-agent grouping ---------------------------------------------------


def test_per_agent_groups_in_stable_order(store) -> None:
    _seed_handoff(store, "wrb_aaaaaaaaaaaa", "h1", "Hermes", "COMPLETED")
    _seed_handoff(store, "wrb_bbbbbbbbbbbb", "oc1", "OpenClaw", "IN PROGRESS")
    _seed_handoff(store, "wrb_cccccccccccc", "cx1", "Codex", "BLOCKED")
    _seed_handoff(store, "wrb_dddddddddddd", "u1", "User", "PENDING")
    _seed_handoff(store, "wrb_eeeeeeeeeeee", "rb1", "Robot", "PENDING")

    out = render_activity_timeline(store)

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


def test_limit_per_agent_is_per_agent_not_global(store) -> None:
    # 6 Hermes tasks, 4 OpenClaw tasks. limit_per_agent=3 -> 3 + 3 lines.
    for i in range(6):
        _seed_handoff(
            store, f"wrb_aaa{i:09x}", f"H job {i}", "Hermes", "COMPLETED"
        )
    for i in range(4):
        _seed_handoff(
            store, f"wrb_bbb{i:09x}", f"OC job {i}", "OpenClaw", "PENDING"
        )

    out = render_activity_timeline(store, limit_per_agent=3)

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


def test_entries_sort_newest_first_by_timestamp(store) -> None:
    _seed_handoff(store, "wrb_111111111111", "old task", "Hermes", "COMPLETED")
    _seed_handoff(store, "wrb_222222222222", "new task", "Hermes", "COMPLETED")
    _seed_handoff(store, "wrb_333333333333", "mid task", "Hermes", "COMPLETED")
    _set_pages(
        store,
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

    out = render_activity_timeline(store, limit_per_agent=10)
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


def test_untimestamped_entries_sink_to_bottom_in_stable_order(store) -> None:
    _seed_handoff(store, "wrb_aaaaaaaaaaaa", "no ts A", "Hermes", "COMPLETED")
    _seed_handoff(store, "wrb_bbbbbbbbbbbb", "has ts", "Hermes", "COMPLETED")
    _seed_handoff(store, "wrb_cccccccccccc", "no ts B", "Hermes", "COMPLETED")
    _set_pages(
        store,
        {
            "page-B": {
                "handoff_key": "wrb_bbbbbbbbbbbb",
                "last_synced_at": "2026-05-17T10:00:00Z",
            }
        },
    )

    out = render_activity_timeline(store, limit_per_agent=10)
    hermes_section = out.split("### Hermes", 1)[1]

    ts_idx = hermes_section.index("has ts")
    no_a_idx = hermes_section.index("no ts A")
    no_b_idx = hermes_section.index("no ts B")

    # Timestamped first, then untimestamped in original insertion order.
    assert ts_idx < no_a_idx < no_b_idx

    # Untimestamped lines render with the placeholder.
    placeholder = "----------------- UTC"
    assert placeholder in hermes_section


# ---- Sanitization ---------------------------------------------------------


def test_title_sanitization_strips_control_chars(store) -> None:
    _seed_handoff(
        store, "wrb_aaaaaaaaaaaa", "evil\x00title\x1bhere", "Hermes", "COMPLETED"
    )

    out = render_activity_timeline(store)
    assert "\x00" not in out
    assert "\x1b" not in out
    assert "eviltitlehere" in out or "evil title here" in out


# ---- Truncation ----------------------------------------------------------


def test_truncates_when_many_handoffs(store) -> None:
    for i in range(80):
        _seed_handoff(
            store,
            f"wrb_{i:012x}",
            "x" * 180,  # long titles
            "Hermes",
            "COMPLETED",
        )

    out = render_activity_timeline(store, limit_per_agent=80)
    assert len(out) <= MAX_TIMELINE_CHARS
    assert out.endswith("...[truncated]")
