#!/usr/bin/env python3
"""Acceptance/demo script for Notion OS War Room Bridge."""

import os
import sys
import time
import subprocess
from pathlib import Path

# Load config implicitly to ensure environment is okay.
sys.path.insert(0, str(Path(__file__).parent.parent.resolve()))
try:
    from src.config import load_config
except ImportError as e:
    print(f"FAIL: Could not import bridge config: {e}")
    sys.exit(1)

def run_once():
    print("Running: python3 notion_warroom_bridge.py --once")
    res = subprocess.run(
        [sys.executable, "notion_warroom_bridge.py", "--once"],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        print(f"FAIL: bridge exited with {res.returncode}")
        print("STDOUT:", res.stdout)
        print("STDERR:", res.stderr)
        return False
    return True

def get_handoff_contents(warroom_path: Path):
    handoff_file = warroom_path / "HANDOFFS.md"
    if not handoff_file.exists():
        return ""
    return handoff_file.read_text(encoding="utf-8")

def get_dashboard_contents(warroom_path: Path):
    dashboard_file = warroom_path / "CURRENT_STATE.md"
    if not dashboard_file.exists():
        return ""
    return dashboard_file.read_text(encoding="utf-8")

def main():
    try:
        cfg = load_config()
    except Exception as e:
        print(f"FAIL: Failed to load config: {e}")
        sys.exit(1)

    print("--- Demo Acceptance Check ---")
    print("\n1. Create a Notion task draft, then press its Submit button.")
    print("   Open Notion UI, go to your Command Center DB.")
    print("   Create a task titled 'Acceptance Test Task'.")
    print("   Set 'Assignee' to 'Hermes'.")
    print("   Press the Notion `Submit` button so `Submit` is checked and `Status` is `Pending`.")
    input("   [Press Enter only after pressing Submit]")

    print("\n2. Run `python3 notion_warroom_bridge.py --once`.")
    if not run_once():
        sys.exit(1)
    print("PASS: Bridge executed successfully.")

    print("\n3. Task appears in `HANDOFFS.md` in exact protocol format.")
    handoff_text = get_handoff_contents(cfg.warroom_path)
    if "- Task: Acceptance Test Task" not in handoff_text:
        print("FAIL: Task title not found in HANDOFFS.md")
        sys.exit(1)
    if "Status: PENDING" not in handoff_text:
        print("FAIL: Task not in PENDING status in HANDOFFS.md")
        sys.exit(1)
    
    # Extract the key
    import re
    m = re.search(r"- Task: Acceptance Test Task \[([^\]]+)\]", handoff_text)
    if not m:
        print("FAIL: War Room Key not found in HANDOFFS.md")
        sys.exit(1)
    key = m.group(1)
    print(f"PASS: Found task in HANDOFFS.md with key {key}")

    print("\n4. Notion task becomes `Dispatched` and shows `War Room Key`.")
    print("   Look at the Notion UI. The Status should be 'Dispatched'.")
    print(f"   The 'War Room Key' should be '{key}'.")
    input("   [Press Enter after verifying in Notion UI]")

    print("\n5. Manually or via agent update handoff to `Status: COMPLETED` and add `Result`.")
    print("   Automatically updating HANDOFFS.md...")
    # Find block and replace
    new_text = handoff_text.replace("Status: PENDING", "Status: COMPLETED").replace(
        "  Result:\n", "  Result: Acceptance demo automated check passed.\n"
    )
    (cfg.warroom_path / "HANDOFFS.md").write_text(new_text, encoding="utf-8")
    print("PASS: Updated HANDOFFS.md locally.")

    print("\n6. Run `python3 notion_warroom_bridge.py --once` again.")
    if not run_once():
        sys.exit(1)
    print("PASS: Bridge executed successfully.")

    print("\n7. Notion task becomes `Completed` and `Result Summary` updates.")
    print("   Look at the Notion UI. The Status should be 'Completed'.")
    print("   The 'Result Summary' should contain 'Acceptance demo automated check passed.'")
    input("   [Press Enter after verifying in Notion UI]")

    print("\n8. Edit `CURRENT_STATE.md`, run `--once`, and verify the same dashboard block updates in place.")
    print("   Automatically editing CURRENT_STATE.md...")
    dashboard_text = get_dashboard_contents(cfg.warroom_path)
    if "## Active Locks" not in dashboard_text:
        dashboard_text += "\n## Active Locks\n- Active Lock: /home/alhinai/WarRoom/demo_check.lock\n"
    else:
        dashboard_text = dashboard_text.replace("## Active Locks", "## Active Locks\n- Active Lock: /home/alhinai/WarRoom/demo_check.lock")
    (cfg.warroom_path / "CURRENT_STATE.md").write_text(dashboard_text, encoding="utf-8")
    
    if not run_once():
        sys.exit(1)
    print("   Look at the Notion UI for the Dashboard page.")
    print("   The text '- Active Lock: /home/alhinai/WarRoom/demo_check.lock' should appear.")
    input("   [Press Enter after verifying in Notion UI]")

    print("\n9. Run `--once` twice more; no duplicate handoff, dashboard block, or result block appears.")
    run_once()
    run_once()
    
    handoff_text_final = get_handoff_contents(cfg.warroom_path)
    count = handoff_text_final.count("- Task: Acceptance Test Task")
    if count != 1:
        print(f"FAIL: Expected exactly 1 block for task, found {count}")
        sys.exit(1)
    print("PASS: No duplicate handoff blocks.")
    print("   Verify Notion UI has no duplicate dashboards or result blocks.")
    input("   [Press Enter after verifying in Notion UI]")

    print("\nALL DEMO ACCEPTANCE CRITERIA PASSED!")

if __name__ == "__main__":
    main()
