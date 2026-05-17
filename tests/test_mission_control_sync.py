"""Unit tests for src/mission_control_sync.py — Redis-backed."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from unittest.mock import Mock, patch

import fakeredis
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.mission_control_sync import sync_mission_control  # noqa: E402
from src.notion_http import NotionAPIError  # noqa: E402
from src.redis_store import RedisStore  # noqa: E402


@pytest.fixture
def store() -> RedisStore:
    return RedisStore(client=fakeredis.FakeRedis(decode_responses=True))


def _set_mc_hash(store: RedisStore, section_name: str, value: str) -> None:
    state = store.get_bridge_state()
    mc = state.setdefault("mission_control", {})
    entry = mc.setdefault(section_name, {})
    entry["hash"] = value
    store.set_bridge_state(state)


def _set_mc_block(store: RedisStore, section_name: str, block_id: str) -> None:
    state = store.get_bridge_state()
    mc = state.setdefault("mission_control", {})
    entry = mc.setdefault(section_name, {})
    entry["block_id"] = block_id
    store.set_bridge_state(state)


def test_format_block_text():
    pass


def test_sync_mission_control_no_page_id(store):
    client = Mock()
    assert sync_mission_control(client, "", store) == 0


@patch("src.mission_control_sync._sections")
def test_sync_mission_control_skips_on_hash_match(mock_sections, store):
    client = Mock()

    mock_sections.return_value = [
        ("test_section", "Test", lambda s: "content")
    ]

    h = hashlib.sha256(b"# Test\n\ncontent").hexdigest()
    _set_mc_hash(store, "test_section", h)

    assert sync_mission_control(client, "page1", store) == 0
    client.update_block.assert_not_called()


@patch("src.mission_control_sync._sections")
def test_sync_mission_control_updates_block(mock_sections, store):
    client = Mock()

    mock_sections.return_value = [
        ("test_section", "Test", lambda s: "content")
    ]

    _set_mc_hash(store, "test_section", "old_hash")
    _set_mc_block(store, "test_section", "block_123")

    assert sync_mission_control(client, "page1", store) == 1
    client.update_block.assert_called_once()
    # Hash must have advanced.
    new_hash = store.get_bridge_state()["mission_control"]["test_section"]["hash"]
    assert new_hash != "old_hash"


@patch("src.mission_control_sync._sections")
def test_sync_mission_control_creates_block_on_404(mock_sections, store):
    client = Mock()
    client.update_block.side_effect = NotionAPIError(404, "Not Found", {})
    client.append_block_children.return_value = {"results": [{"id": "new_block_456"}]}

    mock_sections.return_value = [
        ("test_section", "Test", lambda s: "content")
    ]

    _set_mc_hash(store, "test_section", "old_hash")
    _set_mc_block(store, "test_section", "block_123")

    assert sync_mission_control(client, "page1", store) == 1
    client.append_block_children.assert_called_once()
    new_block_id = store.get_bridge_state()["mission_control"]["test_section"][
        "block_id"
    ]
    assert new_block_id == "new_block_456"
