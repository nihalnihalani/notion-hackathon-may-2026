import os
import pytest
from pathlib import Path
from unittest.mock import Mock, MagicMock
from src.dashboard_sync import safe_truncate_markdown, push_state_to_notion
from src.state_store import StateStore
from src.notion_http import NotionHTTPClient

def test_safe_truncate():
    text = "hello"
    assert safe_truncate_markdown(text) == "hello"

    text = "a" * 2000
    res = safe_truncate_markdown(text, limit=100)
    assert len(res) == 100 + len("\n...[truncated]")

def test_sync_dashboard_no_block_id(tmp_path):
    client = Mock(spec=NotionHTTPClient)
    store = Mock(spec=StateStore)
    mock_ctx = MagicMock()
    store.locked.return_value = mock_ctx
    mock_ctx.__enter__.return_value = store
    store.dashboard_block_id = None
    store.dashboard_hash = None
    
    assert push_state_to_notion(client, "dummy_dash_page", Path(tmp_path), store) is False

def test_sync_dashboard_no_file(tmp_path):
    client = Mock(spec=NotionHTTPClient)
    store = Mock(spec=StateStore)
    mock_ctx = MagicMock()
    store.locked.return_value = mock_ctx
    mock_ctx.__enter__.return_value = store
    store.dashboard_block_id = "block123"
    store.dashboard_hash = None
    
    # CURRENT_STATE.md doesn't exist
    assert push_state_to_notion(client, "dummy_dash_page", Path(tmp_path), store) is False

def test_sync_dashboard_success(tmp_path):
    client = Mock(spec=NotionHTTPClient)
    store = Mock(spec=StateStore)
    mock_ctx = MagicMock()
    store.locked.return_value = mock_ctx
    mock_ctx.__enter__.return_value = store
    store.dashboard_block_id = "block123"
    store.dashboard_hash = None
    
    warroom = Path(tmp_path)
    state_file = warroom / "CURRENT_STATE.md"
    state_file.write_text("New state")
        
    assert push_state_to_notion(client, "dummy_dash_page", warroom, store) is True
    client.update_block.assert_called_once()
    store.set_dashboard_hash.assert_called_once()

def test_sync_dashboard_unchanged(tmp_path):
    client = Mock(spec=NotionHTTPClient)
    store = Mock(spec=StateStore)
    mock_ctx = MagicMock()
    store.locked.return_value = mock_ctx
    mock_ctx.__enter__.return_value = store
    
    import hashlib
    current_hash = hashlib.sha256(b"New state").hexdigest()
    store.dashboard_block_id = "block123"
    store.dashboard_hash = current_hash
    
    warroom = Path(tmp_path)
    state_file = warroom / "CURRENT_STATE.md"
    state_file.write_text("New state")
        
    assert push_state_to_notion(client, "dummy_dash_page", warroom, store) is False
    client.update_block.assert_not_called()