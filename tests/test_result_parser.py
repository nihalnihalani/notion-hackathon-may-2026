from src.result_sync import _parse_entries

def test_parses_completed_entry():
    text = """
<!-- ID: 11111111-2222-3333-4444-555555555555 -->
- Task: Do thing
  Owner: Hermes
  Files Touched: a.py
  Status: COMPLETED
  Result: All green.
  Next Action: None.
"""
    entries = list(_parse_entries(text))
    assert len(entries) == 1
    task_id, fields = entries[0]
    assert task_id == "11111111-2222-3333-4444-555555555555"
    assert fields["Status"] == "COMPLETED"
    assert fields["Result"] == "All green."
