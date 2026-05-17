"""Unit tests for src/dashboard_sync.py — Redis-backed.

Covers CURRENT_STATE.md → dashboard Notion block syncing.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from unittest.mock import MagicMock, Mock

import fakeredis
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.dashboard_sync import (  # noqa: E402
    push_state_to_notion,
    safe_truncate_markdown,
)
from src.notion_http import NotionHTTPClient  # noqa: E402
from src.redis_store import RedisStore  # noqa: E402


@pytest.fixture
def store() -> RedisStore:
    return RedisStore(client=fakeredis.FakeRedis(decode_responses=True))


def test_safe_truncate():
    text = "hello"
    assert safe_truncate_markdown(text) == "hello"

    text = "a" * 2000
    res = safe_truncate_markdown(text, limit=100)
    assert len(res) == 100 + len("\n...[truncated]")


def test_sync_dashboard_no_block_id(store):
    client = Mock(spec=NotionHTTPClient)
    # Bridge state has no dashboard_block_id.
    assert push_state_to_notion(client, "dummy_dash_page", store) is False


def test_sync_dashboard_no_file(store):
    client = Mock(spec=NotionHTTPClient)
    state = store.get_bridge_state()
    state["dashboard_block_id"] = "block123"
    store.set_bridge_state(state)

    # CURRENT_STATE.md was never set in Redis.
    assert push_state_to_notion(client, "dummy_dash_page", store) is False


def test_sync_dashboard_success(store):
    client = Mock(spec=NotionHTTPClient)
    state = store.get_bridge_state()
    state["dashboard_block_id"] = "block123"
    store.set_bridge_state(state)

    store.set_file("CURRENT_STATE.md", "New state")

    assert push_state_to_notion(client, "dummy_dash_page", store) is True
    client.update_block.assert_called_once()

    # Hash advanced in bridge state.
    assert store.get_bridge_state().get("dashboard_hash")


def test_sync_dashboard_unchanged(store):
    client = Mock(spec=NotionHTTPClient)
    current_hash = hashlib.sha256(b"New state").hexdigest()
    state = store.get_bridge_state()
    state["dashboard_block_id"] = "block123"
    state["dashboard_hash"] = current_hash
    store.set_bridge_state(state)

    store.set_file("CURRENT_STATE.md", "New state")

    assert push_state_to_notion(client, "dummy_dash_page", store) is False
    client.update_block.assert_not_called()
