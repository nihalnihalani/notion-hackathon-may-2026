"""Tests for src/openclaw_screens_sync.py.

Covers the four renderers (memory, docs, team, calendar), the
hash-based skip/upsert flow, the 404-recreate path, and the
one-shot Command Center linker.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.notion_http import NotionAPIError  # noqa: E402
from src.openclaw_screens_sync import (  # noqa: E402
    _last_activity_per_owner,
    link_tasks_page_to_command_center,
    render_calendar_screen,
    render_docs_screen,
    render_memory_screen,
    render_team_screen,
    sync_openclaw_screens,
)
from src.state_store import StateStore  # noqa: E402


# ---- Renderers -----------------------------------------------------------


def test_render_memory_missing_file(tmp_path):
    out = render_memory_screen(tmp_path / "missing.md")
    assert "Live Memory" in out
    assert "no shared memory yet" in out


def test_render_memory_returns_truncated_contents(tmp_path):
    (tmp_path / "SHARED_MEMORY.md").write_text("# My memory\nsome notes\n", "utf-8")
    out = render_memory_screen(tmp_path / "SHARED_MEMORY.md")
    assert "Live Memory" in out
    assert "some notes" in out


def test_render_docs_missing_dir(tmp_path):
    out = render_docs_screen(tmp_path / "nope")
    assert "Live Docs" in out
    assert "no KnowledgeBase directory" in out


def test_render_docs_lists_md_files_sorted(tmp_path):
    kb = tmp_path / "KnowledgeBase"
    kb.mkdir()
    (kb / "alpha.md").write_text("a", "utf-8")
    (kb / "beta.md").write_text("bb", "utf-8")
    nested = kb / "sub"
    nested.mkdir()
    (nested / "gamma.md").write_text("ccc", "utf-8")
    (kb / "ignored.txt").write_text("not md", "utf-8")
    out = render_docs_screen(kb)
    assert "alpha.md (1 bytes)" in out
    assert "beta.md (2 bytes)" in out
    assert "gamma.md (3 bytes)" in out
    assert "ignored.txt" not in out
    # Sorted order: alpha, beta, sub/gamma (by sorted path).
    assert out.index("alpha.md") < out.index("beta.md") < out.index("gamma.md")


def test_render_calendar_missing_file_shows_instructions(tmp_path):
    out = render_calendar_screen(tmp_path / "SCHEDULE.md")
    assert "Live Calendar" in out
    assert "SCHEDULE.md" in out


def test_render_calendar_returns_contents(tmp_path):
    (tmp_path / "SCHEDULE.md").write_text("- Job: daily-digest\n  Owner: Hermes\n", "utf-8")
    out = render_calendar_screen(tmp_path / "SCHEDULE.md")
    assert "daily-digest" in out


# ---- Team-screen + activity --------------------------------------------


def test_last_activity_per_owner_groups_by_owner(tmp_path):
    handoffs = tmp_path / "HANDOFFS.md"
    handoffs.write_text(
        "- Task: A [wrb_aaaaaaaaaaaa]\n  Owner: Hermes\n  Files Touched: x\n  Status: COMPLETED\n  Result: ok\n  Next Action: None\n\n"
        "- Task: B [wrb_bbbbbbbbbbbb]\n  Owner: OpenClaw\n  Files Touched: x\n  Status: COMPLETED\n  Result: ok\n  Next Action: None\n",
        encoding="utf-8",
    )
    state = tmp_path / ".notion_bridge_state.json"
    state.write_text(json.dumps({
        "pages": {
            "page_a": {"handoff_key": "wrb_aaaaaaaaaaaa", "last_synced_at": "2026-05-17T10:00:00Z"},
            "page_b": {"handoff_key": "wrb_bbbbbbbbbbbb", "last_synced_at": "2026-05-17T12:00:00Z"},
        }
    }), encoding="utf-8")

    activity = _last_activity_per_owner(state, handoffs)
    assert activity["Hermes"] == "2026-05-17T10:00:00Z"
    assert activity["OpenClaw"] == "2026-05-17T12:00:00Z"


def test_last_activity_handles_missing_state(tmp_path):
    handoffs = tmp_path / "HANDOFFS.md"
    handoffs.write_text(
        "- Task: A [wrb_aaaaaaaaaaaa]\n  Owner: Hermes\n  Files Touched: x\n  Status: COMPLETED\n  Result: ok\n  Next Action: None\n",
        encoding="utf-8",
    )
    activity = _last_activity_per_owner(tmp_path / "missing.json", handoffs)
    assert activity["Hermes"] is None


def test_render_team_shows_per_owner_activity_and_roles(tmp_path):
    handoffs = tmp_path / "HANDOFFS.md"
    handoffs.write_text(
        "- Task: A [wrb_aaaaaaaaaaaa]\n  Owner: Hermes\n  Files Touched: x\n  Status: COMPLETED\n  Result: ok\n  Next Action: None\n",
        encoding="utf-8",
    )
    state = tmp_path / ".notion_bridge_state.json"
    state.write_text(json.dumps({
        "pages": {"page_a": {"handoff_key": "wrb_aaaaaaaaaaaa", "last_synced_at": "2026-05-17T10:00:00Z"}}
    }), encoding="utf-8")
    roles = tmp_path / "AGENT_ROLES.md"
    roles.write_text("# Roles\n- Hermes: orchestrator\n", "utf-8")

    out = render_team_screen(roles, state, handoffs)
    assert "Hermes" in out
    assert "2026-05-17T10:00:00Z" in out
    assert "orchestrator" in out


def test_render_team_no_handoffs(tmp_path):
    roles = tmp_path / "AGENT_ROLES.md"
    roles.write_text("# Roles\n- Hermes\n", "utf-8")
    out = render_team_screen(roles, tmp_path / "missing.json", tmp_path / "HANDOFFS.md")
    assert "(no handoff history yet)" in out
    assert "Hermes" in out


# ---- sync_openclaw_screens ---------------------------------------------


def _seed_screen_pages(store: StateStore) -> None:
    """Pre-create the four screen entries in state, as the setup script does."""
    with store.locked():
        state = store.load()
        pages = state.setdefault("openclaw_pages", {})
        for key in ("screen_memory", "screen_docs", "screen_team", "screen_calendar"):
            pages[key] = {"page_id": f"page_{key}"}
        store.save(state)


def _seed_warroom(tmp_path: Path) -> None:
    tmp_path.mkdir(parents=True, exist_ok=True)
    (tmp_path / "SHARED_MEMORY.md").write_text("# memory\nv1\n", "utf-8")
    (tmp_path / "AGENT_ROLES.md").write_text("# roles\n", "utf-8")
    (tmp_path / "HANDOFFS.md").write_text("", "utf-8")
    (tmp_path / "SCHEDULE.md").write_text("(empty)\n", "utf-8")
    kb = tmp_path / "KnowledgeBase"
    kb.mkdir(exist_ok=True)
    (kb / "doc.md").write_text("d", "utf-8")


def _make_client(new_ids: list[str]) -> MagicMock:
    client = MagicMock()
    iter_ids = iter(new_ids)

    def fake_append(page_id, children):
        return {"results": [{"id": next(iter_ids), "type": "code"}]}

    client.append_block_children.side_effect = fake_append
    client.update_block.return_value = {"object": "block"}
    return client


def test_sync_skips_screens_with_no_page_entry(tmp_path):
    _seed_warroom(tmp_path)
    store = StateStore(tmp_path)
    client = _make_client([])

    pushed = sync_openclaw_screens(client, tmp_path, store)

    assert pushed == 0
    client.append_block_children.assert_not_called()
    client.update_block.assert_not_called()


def test_first_run_appends_live_block_per_screen(tmp_path):
    _seed_warroom(tmp_path)
    store = StateStore(tmp_path)
    _seed_screen_pages(store)
    client = _make_client([f"blk_{i}" for i in range(10)])

    pushed = sync_openclaw_screens(client, tmp_path, store)

    assert pushed == 4
    assert client.append_block_children.call_count == 4
    client.update_block.assert_not_called()

    pages = store.load()["openclaw_pages"]
    for key in ("screen_memory", "screen_docs", "screen_team", "screen_calendar"):
        assert pages[key]["live_block_id"].startswith("blk_")
        assert len(pages[key]["live_hash"]) == 64


def test_unchanged_content_skips_api(tmp_path):
    _seed_warroom(tmp_path)
    store = StateStore(tmp_path)
    _seed_screen_pages(store)
    client = _make_client([f"blk_{i}" for i in range(10)])
    sync_openclaw_screens(client, tmp_path, store)
    client.reset_mock()

    pushed = sync_openclaw_screens(client, tmp_path, store)

    assert pushed == 0
    client.append_block_children.assert_not_called()
    client.update_block.assert_not_called()


def test_changed_content_updates_only_changed_screen(tmp_path):
    _seed_warroom(tmp_path)
    store = StateStore(tmp_path)
    _seed_screen_pages(store)
    client = _make_client([f"blk_{i}" for i in range(10)])
    sync_openclaw_screens(client, tmp_path, store)
    client.reset_mock()

    # Change only Memory; only one update_block call should fire.
    (tmp_path / "SHARED_MEMORY.md").write_text("# memory\nv2\n", "utf-8")

    pushed = sync_openclaw_screens(client, tmp_path, store)

    assert pushed == 1
    client.append_block_children.assert_not_called()
    client.update_block.assert_called_once()
    args, _ = client.update_block.call_args
    assert args[0] == store.load()["openclaw_pages"]["screen_memory"]["live_block_id"]


def test_404_on_update_recreates_block(tmp_path):
    _seed_warroom(tmp_path)
    store = StateStore(tmp_path)
    _seed_screen_pages(store)
    client = _make_client([f"blk_{i}" for i in range(10)])
    sync_openclaw_screens(client, tmp_path, store)
    deleted_id = store.load()["openclaw_pages"]["screen_memory"]["live_block_id"]
    client.reset_mock()

    (tmp_path / "SHARED_MEMORY.md").write_text("# memory\nv2\n", "utf-8")
    client.update_block.side_effect = NotionAPIError(404, "Not Found")
    client.append_block_children.side_effect = [
        {"results": [{"id": "blk_recreated", "type": "code"}]}
    ]

    pushed = sync_openclaw_screens(client, tmp_path, store)

    assert pushed == 1
    client.update_block.assert_called_once()
    args, _ = client.update_block.call_args
    assert args[0] == deleted_id
    client.append_block_children.assert_called_once()
    assert (
        store.load()["openclaw_pages"]["screen_memory"]["live_block_id"]
        == "blk_recreated"
    )


# ---- link_tasks_page_to_command_center ---------------------------------


def test_link_tasks_page_requires_page_in_state(tmp_path):
    store = StateStore(tmp_path)
    client = MagicMock()
    assert link_tasks_page_to_command_center(client, "db_xyz", store) is False
    client.append_block_children.assert_not_called()


def test_link_tasks_page_appends_link_block_once(tmp_path):
    store = StateStore(tmp_path)
    with store.locked():
        state = store.load()
        state.setdefault("openclaw_pages", {})["screen_tasks"] = {"page_id": "tasks_page_1"}
        store.save(state)
    client = MagicMock()
    client.append_block_children.return_value = {"results": [{"id": "blk_link"}]}

    assert link_tasks_page_to_command_center(client, "db_xyz", store) is True
    args, kwargs = client.append_block_children.call_args
    assert args[0] == "tasks_page_1"
    block = args[1][0]
    assert block["type"] == "link_to_page"
    assert block["link_to_page"]["database_id"] == "db_xyz"

    # Second call is a no-op.
    client.reset_mock()
    assert link_tasks_page_to_command_center(client, "db_xyz", store) is False
    client.append_block_children.assert_not_called()


def test_link_tasks_page_no_op_when_database_id_empty(tmp_path):
    store = StateStore(tmp_path)
    with store.locked():
        state = store.load()
        state.setdefault("openclaw_pages", {})["screen_tasks"] = {"page_id": "tasks_page_1"}
        store.save(state)
    client = MagicMock()
    assert link_tasks_page_to_command_center(client, "", store) is False
    client.append_block_children.assert_not_called()
