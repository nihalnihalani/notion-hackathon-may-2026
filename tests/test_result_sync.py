import pytest
from unittest.mock import MagicMock
from src.result_sync import sync_results, parse_handoffs

def test_parse_handoffs():
    text = '''- Task: Do work [wrb_abc123456789]
  Owner: Hermes
  Files Touched: **
  Status: COMPLETED
  Result: Done
  Next Action: None
'''
    entries = list(parse_handoffs(text))
    assert len(entries) == 1
    assert entries[0][0] == "wrb_abc123456789"
    assert entries[0][1]["Status"] == "COMPLETED"
