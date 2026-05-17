import pytest
from unittest.mock import Mock
from src.mission_control_sync import (
    sync_mission_control, 
    get_file_content, 
    truncate_content, 
    compute_hash,
    MAX_CHARS,
    TRUNCATE_MSG
)

def test_get_file_content_missing(tmp_path):
    filepath = tmp_path / "missing.md"
    assert get_file_content(str(filepath)) == "[ File not initialized or empty ]"

def test_get_file_content_empty(tmp_path):
    filepath = tmp_path / "empty.md"
    filepath.write_text("   \n  ")
    assert get_file_content(str(filepath)) == "[ File not initialized or empty ]"

def test_get_file_content_success(tmp_path):
    filepath = tmp_path / "file.md"
    filepath.write_text("content here")
    assert get_file_content(str(filepath)) == "content here"

def test_truncate_content():
    short_content = "a" * 100
    assert truncate_content(short_content) == short_content

    long_content = "a" * 2000
    truncated = truncate_content(long_content)
    assert len(truncated) == MAX_CHARS + len(TRUNCATE_MSG)
    assert truncated.endswith(TRUNCATE_MSG)
    assert truncated.startswith("a" * MAX_CHARS)

def test_compute_hash():
    assert compute_hash("test") == compute_hash("test")
    assert compute_hash("test1") != compute_hash("test2")

def test_sync_mission_control_no_changes(tmp_path):
    client = Mock()
    store = Mock()
    
    store.get_mc_hash.return_value = compute_hash("[ File not initialized or empty ]")
    
    sync_mission_control(client, "dash_id", str(tmp_path), store)
    
    client.update_block.assert_not_called()
    client.append_block_children.assert_not_called()

def test_sync_mission_control_new_file(tmp_path):
    client = Mock()
    client.append_block_children.return_value = {"results": [{"id": "new_block_123"}]}
    
    store = Mock()
    store.get_mc_hash.return_value = None
    store.get_mc_block.return_value = None
    
    sync_mission_control(client, "dash_id", str(tmp_path), store)
    
    assert client.append_block_children.call_count == 7
    assert store.set_mc_block.call_count == 7
    assert store.set_mc_hash.call_count == 7

def test_sync_mission_control_update_existing(tmp_path):
    client = Mock()
    
    store = Mock()
    store.get_mc_hash.return_value = "old_hash"
    store.get_mc_block.return_value = "existing_block_123"
    
    sync_mission_control(client, "dash_id", str(tmp_path), store)
    
    assert client.update_block.call_count == 7
    assert client.append_block_children.call_count == 0
    assert store.set_mc_block.call_count == 0
    assert store.set_mc_hash.call_count == 7

def test_sync_mission_control_update_fallback_to_append(tmp_path):
    client = Mock()
    client.update_block.side_effect = Exception("Block deleted")
    client.append_block_children.return_value = {"results": [{"id": "new_block_123"}]}
    
    store = Mock()
    store.get_mc_hash.return_value = "old_hash"
    store.get_mc_block.return_value = "deleted_block_123"
    
    sync_mission_control(client, "dash_id", str(tmp_path), store)
    
    assert client.update_block.call_count == 7
    assert client.append_block_children.call_count == 7
    assert store.set_mc_block.call_count == 7
    assert store.set_mc_hash.call_count == 7
