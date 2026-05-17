"""Unit tests for `src/knowledge_base_sync.py`.

Uses a real `StateStore` against `tmp_path` plus `MagicMock` for the Notion
client, matching the patterns in `tests/test_dashboard_sync.py` and
`tests/test_mission_control_sync.py`.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.knowledge_base_sync import sync_knowledge_base  # noqa: E402
from src.notion_http import NotionAPIError  # noqa: E402
from src.state_store import StateStore  # noqa: E402


def _make_warroom(tmp_path: Path) -> Path:
    warroom = tmp_path / "WarRoom"
    warroom.mkdir()
    return warroom


def _make_kb_dir(warroom: Path) -> Path:
    kb = warroom / "KnowledgeBase"
    kb.mkdir()
    return kb


def _mock_create_page_returning(page_id: str):
    return {"object": "page", "id": page_id}


# ---- Empty / missing directory --------------------------------------------


def test_empty_kb_dir_is_no_op(tmp_path):
    warroom = _make_warroom(tmp_path)
    kb = _make_kb_dir(warroom)
    store = StateStore(warroom)
    client = MagicMock()

    touched = sync_knowledge_base(client, "parent_abc", kb, store)

    assert touched == 0
    client.create_page.assert_not_called()
    client.append_block_children.assert_not_called()


def test_missing_kb_dir_is_no_op(tmp_path):
    warroom = _make_warroom(tmp_path)
    store = StateStore(warroom)
    client = MagicMock()

    touched = sync_knowledge_base(
        client, "parent_abc", warroom / "DoesNotExist", store
    )
    assert touched == 0
    client.create_page.assert_not_called()


def test_no_parent_page_id_is_no_op(tmp_path):
    warroom = _make_warroom(tmp_path)
    kb = _make_kb_dir(warroom)
    (kb / "note.md").write_text("# Hello")
    store = StateStore(warroom)
    client = MagicMock()

    touched = sync_knowledge_base(client, "", kb, store)
    assert touched == 0
    client.create_page.assert_not_called()


# ---- First sync creates one page per file ---------------------------------


def test_first_sync_creates_one_page_per_md_file(tmp_path):
    warroom = _make_warroom(tmp_path)
    kb = _make_kb_dir(warroom)
    (kb / "alpha.md").write_text("# Alpha\n\nBody A")
    (kb / "beta.md").write_text("# Beta\n\nBody B")
    sub = kb / "nested"
    sub.mkdir()
    (sub / "gamma.md").write_text("# Gamma\n\nBody C")

    store = StateStore(warroom)
    client = MagicMock()
    page_ids = iter(["pg_alpha", "pg_beta", "pg_gamma"])
    client.create_page.side_effect = lambda parent, title, children=None: (
        _mock_create_page_returning(next(page_ids))
    )

    touched = sync_knowledge_base(client, "parent_abc", kb, store)

    assert touched == 3
    assert client.create_page.call_count == 3
    client.append_block_children.assert_not_called()

    # Each call uses the configured parent page id and a non-empty title.
    for call in client.create_page.call_args_list:
        args, kwargs = call
        # Accept positional or keyword.
        if args:
            parent_arg = args[0]
            title_arg = args[1]
        else:
            parent_arg = kwargs["parent_page_id"]
            title_arg = kwargs["title"]
        assert parent_arg == "parent_abc"
        assert isinstance(title_arg, str) and title_arg

    # State has three persisted page ids.
    state = store.load()
    kb_pages = state["kb_pages"]
    assert len(kb_pages) == 3
    persisted_ids = sorted(entry["page_id"] for entry in kb_pages.values())
    assert persisted_ids == ["pg_alpha", "pg_beta", "pg_gamma"]


def test_first_sync_ignores_non_md_files(tmp_path):
    warroom = _make_warroom(tmp_path)
    kb = _make_kb_dir(warroom)
    (kb / "skip.txt").write_text("not markdown")
    (kb / "skip.json").write_text("{}")
    (kb / "keep.md").write_text("# Keep\n\nBody")
    store = StateStore(warroom)
    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_keep")

    touched = sync_knowledge_base(client, "parent_abc", kb, store)
    assert touched == 1
    assert client.create_page.call_count == 1


# ---- Idempotency: unchanged content makes zero API calls ------------------


def test_unchanged_content_makes_zero_api_calls_on_second_sync(tmp_path):
    warroom = _make_warroom(tmp_path)
    kb = _make_kb_dir(warroom)
    (kb / "alpha.md").write_text("# Alpha\n\nBody A")

    store = StateStore(warroom)
    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_alpha")

    first = sync_knowledge_base(client, "parent_abc", kb, store)
    assert first == 1
    assert client.create_page.call_count == 1

    client.reset_mock()
    second = sync_knowledge_base(client, "parent_abc", kb, store)
    assert second == 0
    client.create_page.assert_not_called()
    client.append_block_children.assert_not_called()


# ---- Changed content appends a single block --------------------------------


def test_changed_content_appends_one_update_via_append_block_children(tmp_path):
    warroom = _make_warroom(tmp_path)
    kb = _make_kb_dir(warroom)
    md = kb / "alpha.md"
    md.write_text("# Alpha\n\nBody A")

    store = StateStore(warroom)
    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_alpha")

    assert sync_knowledge_base(client, "parent_abc", kb, store) == 1
    client.reset_mock()

    md.write_text("# Alpha\n\nBody A revised")

    touched = sync_knowledge_base(client, "parent_abc", kb, store)
    assert touched == 1
    assert client.append_block_children.call_count == 1
    args, _ = client.append_block_children.call_args
    assert args[0] == "pg_alpha"  # appended to the same page
    # No second create_page call.
    client.create_page.assert_not_called()

    # Hash advanced.
    state = store.load()
    entries = list(state["kb_pages"].values())
    assert len(entries) == 1
    assert entries[0]["page_id"] == "pg_alpha"


def test_unchanged_after_update_makes_zero_api_calls(tmp_path):
    warroom = _make_warroom(tmp_path)
    kb = _make_kb_dir(warroom)
    md = kb / "alpha.md"
    md.write_text("# Alpha v1")
    store = StateStore(warroom)
    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_alpha")

    sync_knowledge_base(client, "parent_abc", kb, store)
    md.write_text("# Alpha v2")
    sync_knowledge_base(client, "parent_abc", kb, store)

    client.reset_mock()
    touched = sync_knowledge_base(client, "parent_abc", kb, store)
    assert touched == 0
    client.create_page.assert_not_called()
    client.append_block_children.assert_not_called()


# ---- 404 on append forgets the stored page id ------------------------------


def test_404_on_append_clears_stored_page_id(tmp_path):
    warroom = _make_warroom(tmp_path)
    kb = _make_kb_dir(warroom)
    md = kb / "alpha.md"
    md.write_text("# Alpha v1")

    store = StateStore(warroom)
    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_alpha")

    # Bootstrap: page exists.
    sync_knowledge_base(client, "parent_abc", kb, store)
    # Mutate content so the next sync attempts an append.
    md.write_text("# Alpha v2")

    # Stub append to 404.
    client.append_block_children.side_effect = NotionAPIError(
        404, "page deleted"
    )

    touched = sync_knowledge_base(client, "parent_abc", kb, store)
    # The 404 path is a no-op for this call (page id forgotten).
    assert touched == 0
    assert store.load()["kb_pages"] == {}

    # Next sync recreates the page from scratch.
    client.append_block_children.side_effect = None
    client.create_page.reset_mock()
    client.create_page.return_value = _mock_create_page_returning(
        "pg_alpha_new"
    )

    touched_again = sync_knowledge_base(client, "parent_abc", kb, store)
    assert touched_again == 1
    assert client.create_page.call_count == 1
    state = store.load()
    entries = list(state["kb_pages"].values())
    assert len(entries) == 1
    assert entries[0]["page_id"] == "pg_alpha_new"


# ---- Title derivation -----------------------------------------------------


def test_title_uses_first_heading_when_present(tmp_path):
    warroom = _make_warroom(tmp_path)
    kb = _make_kb_dir(warroom)
    (kb / "alpha.md").write_text("# My Real Title\n\nBody")
    store = StateStore(warroom)
    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_a")

    sync_knowledge_base(client, "parent_abc", kb, store)

    args, kwargs = client.create_page.call_args
    title = args[1] if len(args) >= 2 else kwargs["title"]
    assert title == "My Real Title"


def test_title_falls_back_to_file_stem_when_no_heading(tmp_path):
    warroom = _make_warroom(tmp_path)
    kb = _make_kb_dir(warroom)
    (kb / "no_heading.md").write_text("just body, no heading")
    store = StateStore(warroom)
    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_a")

    sync_knowledge_base(client, "parent_abc", kb, store)
    args, kwargs = client.create_page.call_args
    title = args[1] if len(args) >= 2 else kwargs["title"]
    # First non-empty line is used; falls back to stem only if file is empty.
    assert title == "just body, no heading"


def test_title_falls_back_to_stem_when_file_is_empty(tmp_path):
    warroom = _make_warroom(tmp_path)
    kb = _make_kb_dir(warroom)
    (kb / "empty_note.md").write_text("   \n\n  \n")
    store = StateStore(warroom)
    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_a")

    sync_knowledge_base(client, "parent_abc", kb, store)
    args, kwargs = client.create_page.call_args
    title = args[1] if len(args) >= 2 else kwargs["title"]
    assert title == "empty_note"


# ---- Non-404 API errors leave state untouched ------------------------------


def test_create_page_api_error_leaves_state_unchanged(tmp_path):
    warroom = _make_warroom(tmp_path)
    kb = _make_kb_dir(warroom)
    (kb / "alpha.md").write_text("# Alpha")
    store = StateStore(warroom)
    client = MagicMock()
    client.create_page.side_effect = NotionAPIError(500, "boom")

    touched = sync_knowledge_base(client, "parent_abc", kb, store)
    assert touched == 0
    assert store.load()["kb_pages"] == {}
