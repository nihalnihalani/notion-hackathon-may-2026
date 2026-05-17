"""Unit tests for `src/skill_inbox_sync.py` — Redis-backed.

Mirrors `tests/test_knowledge_base_sync.py`: a `RedisStore` backed by
`fakeredis`, `MagicMock` Notion client, no network.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import fakeredis
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.notion_http import NotionAPIError  # noqa: E402
from src.redis_store import RedisStore  # noqa: E402
from src.skill_inbox_sync import sync_skill_inbox  # noqa: E402


@pytest.fixture
def store() -> RedisStore:
    return RedisStore(client=fakeredis.FakeRedis(decode_responses=True))


def _create_page_response(page_id: str):
    return {"object": "page", "id": page_id}


def _get_skill_pages(store: RedisStore) -> dict:
    return store.get_bridge_state().get("skill_pages") or {}


def _get_kb_pages(store: RedisStore) -> dict:
    return store.get_bridge_state().get("kb_pages") or {}


# ---- Empty / missing inputs -----------------------------------------------


def test_empty_index_is_no_op(store):
    client = MagicMock()
    touched = sync_skill_inbox(client, "parent_abc", store)
    assert touched == 0
    client.create_page.assert_not_called()
    client.append_block_children.assert_not_called()


def test_no_parent_page_id_is_no_op(store):
    store.set_skill("runbook.md", "# Runbook")
    client = MagicMock()

    touched = sync_skill_inbox(client, "", store)
    assert touched == 0
    client.create_page.assert_not_called()


# ---- First sync creates one page per file ---------------------------------


def test_first_sync_creates_one_page_per_md_file(store):
    store.set_skill("deploy.md", "# Deploy\n\nSteps")
    store.set_skill("rollback.md", "# Rollback\n\nSteps")

    client = MagicMock()
    ids = iter(["pg_deploy", "pg_rollback"])
    client.create_page.side_effect = lambda parent, title, children=None: (
        _create_page_response(next(ids))
    )

    touched = sync_skill_inbox(client, "parent_skill", store)
    assert touched == 2
    assert client.create_page.call_count == 2
    client.append_block_children.assert_not_called()

    skill_pages = _get_skill_pages(store)
    assert len(skill_pages) == 2
    persisted_ids = sorted(
        entry["page_id"] for entry in skill_pages.values()
    )
    assert persisted_ids == ["pg_deploy", "pg_rollback"]
    # KB bucket is untouched.
    assert _get_kb_pages(store) == {}


# ---- Idempotency ----------------------------------------------------------


def test_unchanged_content_makes_zero_api_calls_on_second_sync(store):
    store.set_skill("deploy.md", "# Deploy")
    client = MagicMock()
    client.create_page.return_value = _create_page_response("pg_deploy")

    assert sync_skill_inbox(client, "parent_skill", store) == 1

    client.reset_mock()
    assert sync_skill_inbox(client, "parent_skill", store) == 0
    client.create_page.assert_not_called()
    client.append_block_children.assert_not_called()


# ---- Changed content appends one update -----------------------------------


def test_changed_content_appends_via_append_block_children(store):
    store.set_skill("deploy.md", "# Deploy v1")
    client = MagicMock()
    client.create_page.return_value = _create_page_response("pg_deploy")

    sync_skill_inbox(client, "parent_skill", store)
    client.reset_mock()

    store.set_skill("deploy.md", "# Deploy v2")
    touched = sync_skill_inbox(client, "parent_skill", store)

    assert touched == 1
    assert client.append_block_children.call_count == 1
    args, _ = client.append_block_children.call_args
    assert args[0] == "pg_deploy"
    client.create_page.assert_not_called()


# ---- 404 on append forgets the stored page id -----------------------------


def test_404_on_append_clears_stored_page_id(store):
    store.set_skill("deploy.md", "# Deploy v1")
    client = MagicMock()
    client.create_page.return_value = _create_page_response("pg_deploy")

    sync_skill_inbox(client, "parent_skill", store)
    store.set_skill("deploy.md", "# Deploy v2")

    client.append_block_children.side_effect = NotionAPIError(404, "gone")

    touched = sync_skill_inbox(client, "parent_skill", store)
    assert touched == 0
    assert _get_skill_pages(store) == {}

    # Recreates from scratch on the next sync.
    client.append_block_children.side_effect = None
    client.create_page.reset_mock()
    client.create_page.return_value = _create_page_response("pg_deploy_new")
    touched_again = sync_skill_inbox(client, "parent_skill", store)
    assert touched_again == 1
    assert client.create_page.call_count == 1
    entries = list(_get_skill_pages(store).values())
    assert len(entries) == 1
    assert entries[0]["page_id"] == "pg_deploy_new"


def test_create_page_api_error_leaves_state_unchanged(store):
    store.set_skill("deploy.md", "# Deploy")
    client = MagicMock()
    client.create_page.side_effect = NotionAPIError(500, "boom")

    touched = sync_skill_inbox(client, "parent_skill", store)
    assert touched == 0
    assert _get_skill_pages(store) == {}


# ---- Buckets isolated -----------------------------------------------------


def test_skill_inbox_does_not_touch_kb_state(store):
    store.set_skill("deploy.md", "# Deploy")
    # Pre-populate kb_pages to ensure skill sync doesn't disturb it.
    state = store.get_bridge_state()
    state["kb_pages"] = {"preexisting": {"page_id": "pg_kb", "hash": "hash_kb"}}
    store.set_bridge_state(state)

    client = MagicMock()
    client.create_page.return_value = _create_page_response("pg_deploy")

    sync_skill_inbox(client, "parent_skill", store)
    kb_pages = _get_kb_pages(store)
    assert kb_pages.get("preexisting") == {
        "page_id": "pg_kb",
        "hash": "hash_kb",
    }
