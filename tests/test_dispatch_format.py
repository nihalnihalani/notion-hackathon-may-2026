import os
from src.dispatch_sync import append_handoff_entry, NOTION_ID_MARKER_FMT

def test_handoff_has_six_fields(tmp_path):
    warroom = str(tmp_path)
    os.makedirs(warroom, exist_ok=True)
    open(os.path.join(warroom, "HANDOFFS.md"), "w").close()
    
    append_handoff_entry(
        task_id="abc12345-0000-0000-0000-000000000000",
        title="Demo Task",
        assignee="Hermes",
        context="hello world",
        files_touched="src/foo.py",
        work_dir="projects/foo",
        next_action="run tests",
        warroom_path=warroom,
    )
    text = open(os.path.join(warroom, "HANDOFFS.md")).read()
    
    assert NOTION_ID_MARKER_FMT.format(task_id="abc12345-0000-0000-0000-000000000000") in text
    for field in ("- Task:", "Owner:", "Files Touched:", "Status:", "Result:", "Next Action:"):
        assert field in text

def test_owner_defaults_to_hermes_on_invalid(tmp_path):
    warroom = str(tmp_path)
    os.makedirs(warroom, exist_ok=True)
    open(os.path.join(warroom, "HANDOFFS.md"), "w").close()
    
    append_handoff_entry("id-1", "T", "Gremlin", "", "", "", "", warroom)
    text = open(os.path.join(warroom, "HANDOFFS.md")).read()
    assert "Owner: Hermes" in text
