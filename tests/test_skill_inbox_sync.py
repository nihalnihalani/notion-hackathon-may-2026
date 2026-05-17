"""Unit tests for `src/skill_inbox_sync.py`.

Mirrors `tests/test_knowledge_base_sync.py`: real `StateStore` against
`tmp_path`, `MagicMock` Notion client, no network.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.notion_http import NotionAPIError  # noqa: E402
from src.skill_inbox_sync import sync_skill_inbox  # noqa: E402
from src.state_store import StateStore  # noqa: E402


def _make_warroom(tmp_path: Path) -> Path:
    warroom = tmp_path / "WarRoom"
    warroom.mkdir()
    return warroom


def _make_skill_dir(warroom: Path) -> Path:
    skill = warroom / "Skill_Inbox"
    skill.mkdir()
    return skill


def _create_page_response(page_id: str):
    return {"object": "page", "id": page_id}


# ---- Empty / missing inputs -----------------------------------------------


def test_empty_dir_is_no_op(tmp_path):
    warroom = _make_warroom(tmp_path)
    skill = _make_skill_dir(warroom)
    store = StateStore(warroom)
    client = MagicMock()

    touched = sync_skill_inbox(client, "parent_abc", skill, store)

    assert touched == 0
    client.create_page.assert_not_called()
    client.append_block_children.assert_not_called()


def test_missing_dir_is_no_op(tmp_path):
    warroom = _make_warroom(tmp_path)
    store = StateStore(warroom)
    client = MagicMock()
    touched = sync_skill_inbox(
        client, "parent_abc", warroom / "DoesNotExist", store
    )
    assert touched == 0
    client.create_page.assert_not_called()


def test_no_parent_page_id_is_no_op(tmp_path):
    warroom = _make_warroom(tmp_path)
    skill = _make_skill_dir(warroom)
    (skill / "runbook.md").write_text("# Runbook")
    store = StateStore(warroom)
    client = MagicMock()

    touched = sync_skill_inbox(client, "", skill, store)
    assert touched == 0
    client.create_page.assert_not_called()


# ---- First sync creates one page per file ---------------------------------


def test_first_sync_creates_one_page_per_md_file(tmp_path):
    warroom = _make_warroom(tmp_path)
    skill = _make_skill_dir(warroom)
    (skill / "deploy.md").write_text("# Deploy\n\nSteps")
    (skill / "rollback.md").write_text("# Rollback\n\nSteps")

    store = StateStore(warroom)
    client = MagicMock()
    ids = iter(["pg_deploy", "pg_rollback"])
    client.create_page.side_effect = lambda parent, title, children=None: (
        _create_page_response(next(ids))
    )

    touched = sync_skill_inbox(client, "parent_skill", skill, store)
    assert touched == 2
    assert client.create_page.call_count == 2
    client.append_block_children.assert_not_called()

    state = store.load()
    assert len(state["skill_pages"]) == 2
    persisted_ids = sorted(
        entry["page_id"] for entry in state["skill_pages"].values()
    )
    assert persisted_ids == ["pg_deploy", "pg_rollback"]
    # KB bucket is untouched.
    assert state["kb_pages"] == {}


# ---- Idempotency ----------------------------------------------------------


def test_unchanged_content_makes_zero_api_calls_on_second_sync(tmp_path):
    warroom = _make_warroom(tmp_path)
    skill = _make_skill_dir(warroom)
    (skill / "deploy.md").write_text("# Deploy")
    store = StateStore(warroom)
    client = MagicMock()
    client.create_page.return_value = _create_page_response("pg_deploy")

    assert sync_skill_inbox(client, "parent_skill", skill, store) == 1

    client.reset_mock()
    assert sync_skill_inbox(client, "parent_skill", skill, store) == 0
    client.create_page.assert_not_called()
    client.append_block_children.assert_not_called()


# ---- Changed content appends one update -----------------------------------


def test_changed_content_appends_via_append_block_children(tmp_path):
    warroom = _make_warroom(tmp_path)
    skill = _make_skill_dir(warroom)
    md = skill / "deploy.md"
    md.write_text("# Deploy v1")
    store = StateStore(warroom)
    client = MagicMock()
    client.create_page.return_value = _create_page_response("pg_deploy")

    sync_skill_inbox(client, "parent_skill", skill, store)
    client.reset_mock()

    md.write_text("# Deploy v2")
    touched = sync_skill_inbox(client, "parent_skill", skill, store)

    assert touched == 1
    assert client.append_block_children.call_count == 1
    args, _ = client.append_block_children.call_args
    assert args[0] == "pg_deploy"
    client.create_page.assert_not_called()


# ---- 404 on append forgets the stored page id -----------------------------


def test_404_on_append_clears_stored_page_id(tmp_path):
    warroom = _make_warroom(tmp_path)
    skill = _make_skill_dir(warroom)
    md = skill / "deploy.md"
    md.write_text("# Deploy v1")
    store = StateStore(warroom)
    client = MagicMock()
    client.create_page.return_value = _create_page_response("pg_deploy")

    sync_skill_inbox(client, "parent_skill", skill, store)
    md.write_text("# Deploy v2")

    client.append_block_children.side_effect = NotionAPIError(404, "gone")

    touched = sync_skill_inbox(client, "parent_skill", skill, store)
    assert touched == 0
    assert store.load()["skill_pages"] == {}

    # Recreates from scratch on the next sync.
    client.append_block_children.side_effect = None
    client.create_page.reset_mock()
    client.create_page.return_value = _create_page_response("pg_deploy_new")
    touched_again = sync_skill_inbox(client, "parent_skill", skill, store)
    assert touched_again == 1
    assert client.create_page.call_count == 1
    entries = list(store.load()["skill_pages"].values())
    assert len(entries) == 1
    assert entries[0]["page_id"] == "pg_deploy_new"


def test_create_page_api_error_leaves_state_unchanged(tmp_path):
    warroom = _make_warroom(tmp_path)
    skill = _make_skill_dir(warroom)
    (skill / "deploy.md").write_text("# Deploy")
    store = StateStore(warroom)
    client = MagicMock()
    client.create_page.side_effect = NotionAPIError(500, "boom")

    touched = sync_skill_inbox(client, "parent_skill", skill, store)
    assert touched == 0
    assert store.load()["skill_pages"] == {}


# ---- Buckets isolated -----------------------------------------------------


def test_skill_inbox_does_not_touch_kb_state(tmp_path):
    warroom = _make_warroom(tmp_path)
    skill = _make_skill_dir(warroom)
    (skill / "deploy.md").write_text("# Deploy")
    store = StateStore(warroom)
    # Pre-populate kb_pages to ensure skill sync doesn't disturb it.
    store.set_kb_page("preexisting", "pg_kb", "hash_kb")

    client = MagicMock()
    client.create_page.return_value = _create_page_response("pg_deploy")

    sync_skill_inbox(client, "parent_skill", skill, store)
    assert store.get_kb_page("preexisting") == {
        "page_id": "pg_kb",
        "hash": "hash_kb",
    }
