import os
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
from src.notion_http import NotionHTTPClient, NotionAPIError
from src.state_store import StateStore
from src.mission_control_sync import sync_mission_control

def test_format_block_text():
    pass

def test_sync_mission_control_no_page_id():
    client = Mock()
    store = Mock()
    assert sync_mission_control(client, "", ".", store) == 0

@patch("src.mission_control_sync._sections")
def test_sync_mission_control_skips_on_hash_match(mock_sections, tmp_path):
    client = Mock()
    store = Mock(spec=StateStore)
    
    mock_sections.return_value = [
        ("test_section", "Test", lambda w: "content")
    ]
    
    import hashlib
    h = hashlib.sha256(b"# Test\n\ncontent").hexdigest()
    store.get_mc_hash.return_value = h
    
    assert sync_mission_control(client, "page1", str(tmp_path), store) == 0
    client.update_block.assert_not_called()

@patch("src.mission_control_sync._sections")
def test_sync_mission_control_updates_block(mock_sections, tmp_path):
    client = Mock()
    store = Mock(spec=StateStore)
    
    mock_sections.return_value = [
        ("test_section", "Test", lambda w: "content")
    ]
    
    store.get_mc_hash.return_value = "old_hash"
    store.get_mc_block.return_value = "block_123"
    
    assert sync_mission_control(client, "page1", str(tmp_path), store) == 1
    client.update_block.assert_called_once()
    store.set_mc_hash.assert_called_once()

@patch("src.mission_control_sync._sections")
def test_sync_mission_control_creates_block_on_404(mock_sections, tmp_path):
    client = Mock()
    client.update_block.side_effect = NotionAPIError(404, "Not Found", {})
    client.append_block_children.return_value = {"results": [{"id": "new_block_456"}]}
    
    store = Mock(spec=StateStore)
    mock_sections.return_value = [
        ("test_section", "Test", lambda w: "content")
    ]
    
    store.get_mc_hash.return_value = "old_hash"
    store.get_mc_block.return_value = "block_123"
    
    assert sync_mission_control(client, "page1", str(tmp_path), store) == 1
    client.append_block_children.assert_called_once()
    store.set_mc_block.assert_any_call("test_section", None)
    store.set_mc_block.assert_any_call("test_section", "new_block_456")
