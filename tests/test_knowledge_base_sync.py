"""Unit tests for `src/knowledge_base_sync.py` — Redis-backed."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import fakeredis
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.knowledge_base_sync import sync_knowledge_base  # noqa: E402
from src.notion_http import NotionAPIError  # noqa: E402
from src.redis_store import RedisStore  # noqa: E402


@pytest.fixture
def store() -> RedisStore:
    return RedisStore(client=fakeredis.FakeRedis(decode_responses=True))


def _mock_create_page_returning(page_id: str):
    return {"object": "page", "id": page_id}


def _get_kb_pages(store: RedisStore) -> dict:
    """Read the kb_pages dict from bridge state, returning {} if absent."""
    return store.get_bridge_state().get("kb_pages") or {}


# ---- Empty / missing index ------------------------------------------------


def test_empty_kb_index_is_no_op(store):
    client = MagicMock()
    touched = sync_knowledge_base(client, "parent_abc", store)
    assert touched == 0
    client.create_page.assert_not_called()
    client.append_block_children.assert_not_called()


def test_no_parent_page_id_is_no_op(store):
    store.set_kb_doc("note.md", "# Hello")
    client = MagicMock()

    touched = sync_knowledge_base(client, "", store)
    assert touched == 0
    client.create_page.assert_not_called()


# ---- First sync creates one page per file ---------------------------------


def test_first_sync_creates_one_page_per_md_file(store):
    store.set_kb_doc("alpha.md", "# Alpha\n\nBody A")
    store.set_kb_doc("beta.md", "# Beta\n\nBody B")
    store.set_kb_doc("nested/gamma.md", "# Gamma\n\nBody C")

    client = MagicMock()
    page_ids = iter(["pg_alpha", "pg_beta", "pg_gamma"])
    client.create_page.side_effect = lambda parent, title, children=None: (
        _mock_create_page_returning(next(page_ids))
    )

    touched = sync_knowledge_base(client, "parent_abc", store)

    assert touched == 3
    assert client.create_page.call_count == 3
    client.append_block_children.assert_not_called()

    # Each call uses the configured parent page id and a non-empty title.
    for call in client.create_page.call_args_list:
        args, kwargs = call
        if args:
            parent_arg = args[0]
            title_arg = args[1]
        else:
            parent_arg = kwargs["parent_page_id"]
            title_arg = kwargs["title"]
        assert parent_arg == "parent_abc"
        assert isinstance(title_arg, str) and title_arg

    # State has three persisted page ids.
    kb_pages = _get_kb_pages(store)
    assert len(kb_pages) == 3
    persisted_ids = sorted(entry["page_id"] for entry in kb_pages.values())
    assert persisted_ids == ["pg_alpha", "pg_beta", "pg_gamma"]


# ---- Idempotency: unchanged content makes zero API calls ------------------


def test_unchanged_content_makes_zero_api_calls_on_second_sync(store):
    store.set_kb_doc("alpha.md", "# Alpha\n\nBody A")

    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_alpha")

    first = sync_knowledge_base(client, "parent_abc", store)
    assert first == 1
    assert client.create_page.call_count == 1

    client.reset_mock()
    second = sync_knowledge_base(client, "parent_abc", store)
    assert second == 0
    client.create_page.assert_not_called()
    client.append_block_children.assert_not_called()


# ---- Changed content appends a single block --------------------------------


def test_changed_content_appends_one_update_via_append_block_children(store):
    store.set_kb_doc("alpha.md", "# Alpha\n\nBody A")

    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_alpha")

    assert sync_knowledge_base(client, "parent_abc", store) == 1
    client.reset_mock()

    store.set_kb_doc("alpha.md", "# Alpha\n\nBody A revised")

    touched = sync_knowledge_base(client, "parent_abc", store)
    assert touched == 1
    assert client.append_block_children.call_count == 1
    args, _ = client.append_block_children.call_args
    assert args[0] == "pg_alpha"  # appended to the same page
    # No second create_page call.
    client.create_page.assert_not_called()

    # Hash advanced.
    entries = list(_get_kb_pages(store).values())
    assert len(entries) == 1
    assert entries[0]["page_id"] == "pg_alpha"


def test_unchanged_after_update_makes_zero_api_calls(store):
    store.set_kb_doc("alpha.md", "# Alpha v1")
    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_alpha")

    sync_knowledge_base(client, "parent_abc", store)
    store.set_kb_doc("alpha.md", "# Alpha v2")
    sync_knowledge_base(client, "parent_abc", store)

    client.reset_mock()
    touched = sync_knowledge_base(client, "parent_abc", store)
    assert touched == 0
    client.create_page.assert_not_called()
    client.append_block_children.assert_not_called()


# ---- 404 on append forgets the stored page id ------------------------------


def test_404_on_append_clears_stored_page_id(store):
    store.set_kb_doc("alpha.md", "# Alpha v1")

    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_alpha")

    # Bootstrap: page exists.
    sync_knowledge_base(client, "parent_abc", store)
    # Mutate content so the next sync attempts an append.
    store.set_kb_doc("alpha.md", "# Alpha v2")

    # Stub append to 404.
    client.append_block_children.side_effect = NotionAPIError(
        404, "page deleted"
    )

    touched = sync_knowledge_base(client, "parent_abc", store)
    # The 404 path is a no-op for this call (page id forgotten).
    assert touched == 0
    assert _get_kb_pages(store) == {}

    # Next sync recreates the page from scratch.
    client.append_block_children.side_effect = None
    client.create_page.reset_mock()
    client.create_page.return_value = _mock_create_page_returning(
        "pg_alpha_new"
    )

    touched_again = sync_knowledge_base(client, "parent_abc", store)
    assert touched_again == 1
    assert client.create_page.call_count == 1
    entries = list(_get_kb_pages(store).values())
    assert len(entries) == 1
    assert entries[0]["page_id"] == "pg_alpha_new"


# ---- Title derivation -----------------------------------------------------


def test_title_uses_first_heading_when_present(store):
    store.set_kb_doc("alpha.md", "# My Real Title\n\nBody")
    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_a")

    sync_knowledge_base(client, "parent_abc", store)

    args, kwargs = client.create_page.call_args
    title = args[1] if len(args) >= 2 else kwargs["title"]
    assert title == "My Real Title"


def test_title_falls_back_to_file_stem_when_no_heading(store):
    store.set_kb_doc("no_heading.md", "just body, no heading")
    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_a")

    sync_knowledge_base(client, "parent_abc", store)
    args, kwargs = client.create_page.call_args
    title = args[1] if len(args) >= 2 else kwargs["title"]
    # First non-empty line is used; falls back to stem only if file is empty.
    assert title == "just body, no heading"


def test_title_falls_back_to_stem_when_file_is_empty(store):
    store.set_kb_doc("empty_note.md", "   \n\n  \n")
    client = MagicMock()
    client.create_page.return_value = _mock_create_page_returning("pg_a")

    sync_knowledge_base(client, "parent_abc", store)
    args, kwargs = client.create_page.call_args
    title = args[1] if len(args) >= 2 else kwargs["title"]
    assert title == "empty_note"


# ---- Non-404 API errors leave state untouched ------------------------------


def test_create_page_api_error_leaves_state_unchanged(store):
    store.set_kb_doc("alpha.md", "# Alpha")
    client = MagicMock()
    client.create_page.side_effect = NotionAPIError(500, "boom")

    touched = sync_knowledge_base(client, "parent_abc", store)
    assert touched == 0
    assert _get_kb_pages(store) == {}
