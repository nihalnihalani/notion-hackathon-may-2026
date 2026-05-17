import os
import pytest
from unittest.mock import MagicMock
from pathlib import Path
from src.dispatch_sync import sync_dispatch, _detect_lock_conflict

def test_active_lock_conflict():
    locks = "- Active Lock: /home/alhinai/WarRoom/test.py"
    assert _detect_lock_conflict("/home/alhinai/WarRoom/test.py", locks) is not None
    assert _detect_lock_conflict("/home/alhinai/WarRoom/other.py", locks) is None

def test_sync_dispatch_no_tasks(tmp_path):
    client = MagicMock()
    client.query_database.return_value = {"results": [], "has_more": False}
    
    dispatched = sync_dispatch(client, "db_123", tmp_path)
    assert dispatched == 0
