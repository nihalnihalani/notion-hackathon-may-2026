import os
from pathlib import Path
from unittest.mock import Mock
import pytest

from src.state_observer import push_file_to_notion
from src.notion_http import NotionHTTPClient

def test_push_file_to_notion_no_block_id(tmp_path):
    client = Mock(spec=NotionHTTPClient)
    assert push_file_to_notion(client, None, "test.md", ".test_hash", str(tmp_path)) is False

def test_push_file_to_notion_no_file(tmp_path):
    client = Mock(spec=NotionHTTPClient)
    assert push_file_to_notion(client, "block123", "test.md", ".test_hash", str(tmp_path)) is False

def test_push_file_to_notion_success(tmp_path):
    client = Mock(spec=NotionHTTPClient)
    warroom = str(tmp_path)
    file_path = tmp_path / "test.md"
    file_path.write_text("Hello World", encoding="utf-8")
    
    assert push_file_to_notion(client, "block123", "test.md", ".test_hash", warroom) is True
    client.update_block.assert_called_once()
    
    # Verify hash file was created
    hash_file = tmp_path / ".test_hash"
    assert hash_file.exists()

def test_push_file_to_notion_unchanged(tmp_path):
    client = Mock(spec=NotionHTTPClient)
    warroom = str(tmp_path)
    file_path = tmp_path / "test.md"
    file_path.write_text("Hello World", encoding="utf-8")
    
    # First call creates the hash
    assert push_file_to_notion(client, "block123", "test.md", ".test_hash", warroom) is True
    client.update_block.reset_mock()
    
    # Second call should be a no-op
    assert push_file_to_notion(client, "block123", "test.md", ".test_hash", warroom) is False
    client.update_block.assert_not_called()

def test_push_file_to_notion_tail_only(tmp_path):
    client = Mock(spec=NotionHTTPClient)
    warroom = str(tmp_path)
    file_path = tmp_path / "test.md"
    long_content = "a" * 2000
    file_path.write_text(long_content, encoding="utf-8")
    
    assert push_file_to_notion(client, "block123", "test.md", ".test_hash", warroom, tail_only=True) is True
    
    # Extract the payload to ensure it truncated
    call_args = client.update_block.call_args[1]
    content_sent = call_args["code_payload"]["rich_text"][0]["text"]["content"]
    assert "...[truncated]" in content_sent
    assert len(content_sent) <= 1900
