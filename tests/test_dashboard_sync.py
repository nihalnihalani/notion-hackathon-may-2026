import os
import pytest
from unittest.mock import Mock, MagicMock

from src.dashboard_sync import safe_truncate_markdown, sync_dashboard
from src.state_store import StateStore
from src.notion_http import NotionHTTPClient

def test_safe_truncate_markdown_short():
    text = "Hello world"
    assert safe_truncate_markdown(text) == text

def test_safe_truncate_markdown_long():
    text = "a" * 2000
    res = safe_truncate_markdown(text, limit=100)
    assert len(res) < 200
    assert res.endswith("...[truncated]")

def test_safe_truncate_markdown_fences():
    text = "```python\n" + "a" * 2000 + "\n```"
    res = safe_truncate_markdown(text, limit=100)
    assert res.count("```") == 2

def test_sync_dashboard_no_block_id(tmp_path):
    client = Mock(spec=NotionHTTPClient)
    # create a mock store
    store = Mock(spec=StateStore)
    mock_ctx = MagicMock()
    store.locked.return_value = mock_ctx
    mock_ctx.__enter__.return_value = store
    store.load.return_value = {}
    
    assert sync_dashboard(client, store, str(tmp_path), block_id=None) is False

def test_sync_dashboard_no_file(tmp_path):
    client = Mock(spec=NotionHTTPClient)
    store = Mock(spec=StateStore)
    mock_ctx = MagicMock()
    store.locked.return_value = mock_ctx
    mock_ctx.__enter__.return_value = store
    store.load.return_value = {"dashboard_block_id": "block123"}
    
    # CURRENT_STATE.md doesn't exist
    assert sync_dashboard(client, store, str(tmp_path)) is False

def test_sync_dashboard_success(tmp_path):
    client = Mock(spec=NotionHTTPClient)
    store = Mock(spec=StateStore)
    mock_ctx = MagicMock()
    store.locked.return_value = mock_ctx
    mock_ctx.__enter__.return_value = store
    store.load.return_value = {"dashboard_block_id": "block123"}
    
    warroom = str(tmp_path)
    state_file = os.path.join(warroom, "CURRENT_STATE.md")
    with open(state_file, "w") as f:
        f.write("New state")
        
    assert sync_dashboard(client, store, warroom) is True
    client.update_block.assert_called_once()
    store.save.assert_called_once()

def test_sync_dashboard_unchanged(tmp_path):
    client = Mock(spec=NotionHTTPClient)
    store = Mock(spec=StateStore)
    mock_ctx = MagicMock()
    store.locked.return_value = mock_ctx
    mock_ctx.__enter__.return_value = store
    
    import hashlib
    current_hash = hashlib.sha256(b"New state").hexdigest()
    store.load.return_value = {"dashboard_block_id": "block123", "dashboard_hash": current_hash}
    
    warroom = str(tmp_path)
    state_file = os.path.join(warroom, "CURRENT_STATE.md")
    with open(state_file, "w") as f:
        f.write("New state")
        
    assert sync_dashboard(client, store, warroom) is False
    client.update_block.assert_not_called()
