#!/usr/bin/env python3
import os
import sys
import subprocess
import time
from pathlib import Path

def run_cmd(cmd):
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.returncode, result.stdout, result.stderr

def print_step(msg):
    print(f"\n\033[1;34m=== {msg} ===\033[0m")

def fail(msg):
    print(f"\033[1;31m[FAIL]\033[0m {msg}")
    sys.exit(1)

def pass_check(msg):
    print(f"\033[1;32m[PASS]\033[0m {msg}")

def main():
    warroom_path = Path(os.path.expanduser("~/WarRoom"))
    handoffs_file = warroom_path / "HANDOFFS.md"
    state_file = warroom_path / "CURRENT_STATE.md"
    
    # Pre-setup
    os.makedirs(warroom_path, exist_ok=True)
    if not handoffs_file.exists():
        handoffs_file.touch()
    if not state_file.exists():
        state_file.write_text("# Initial State\n\nAll systems nominal.")

    print_step("Step 1: Create Notion Task")
    print("Please go to Notion and create a task in the Command Center DB:")
    print("  - Title: Demo Task")
    print("  - Status: Pending")
    print("  - Assignee: Hermes")
    print("  - Authorized Files: /home/alhinai/WarRoom/**")
    input("\nPress Enter when the task is created in Notion...")

    print_step("Step 2: Run Daemon (--once)")
    rc, stdout, stderr = run_cmd("python3 notion_warroom_bridge.py --once")
    if rc != 0:
        fail(f"Daemon failed to run:\n{stderr}\n{stdout}")
    pass_check("Daemon executed successfully.")

    print_step("Step 3 & 4: Verify HANDOFFS.md and Notion State")
    content = handoffs_file.read_text()
    if "Demo Task" not in content or "Status: PENDING" not in content:
        fail(f"Demo Task not found in HANDOFFS.md or incorrect format.\nContent:\n{content}")
    pass_check("Task successfully dispatched to HANDOFFS.md.")

    print("Please verify in Notion that:")
    print("  - Status changed to 'Dispatched'")
    print("  - 'War Room Key' property is populated (e.g. wrb_...)")
    input("\nPress Enter when verified...")

    print_step("Step 5: Local Update to COMPLETED")
    # Replace PENDING with COMPLETED
    new_content = content.replace("Status: PENDING", "Status: COMPLETED")
    new_content = new_content.replace("Result:", "Result: This was successfully executed locally.")
    handoffs_file.write_text(new_content)
    pass_check("Locally updated HANDOFFS.md to Status: COMPLETED.")

    print_step("Step 6: Run Daemon (--once)")
    rc, stdout, stderr = run_cmd("python3 notion_warroom_bridge.py --once")
    if rc != 0:
        fail(f"Daemon failed to run:\n{stderr}\n{stdout}")
    pass_check("Daemon executed successfully.")

    print_step("Step 7: Verify Result in Notion")
    print("Please verify in Notion that:")
    print("  - Status changed to 'Completed'")
    print("  - 'Result Summary' property is updated")
    input("\nPress Enter when verified...")

    print_step("Step 8: Dashboard Live Update")
    state_file.write_text("# Updated State\n\nTesting live dashboard update.")
    pass_check("Locally updated CURRENT_STATE.md.")
    
    rc, stdout, stderr = run_cmd("python3 notion_warroom_bridge.py --once")
    if rc != 0:
        fail(f"Daemon failed to run:\n{stderr}\n{stdout}")
    pass_check("Daemon executed successfully.")

    print("Please verify in Notion that the Dashboard code block shows '# Updated State'")
    input("\nPress Enter when verified...")

    print_step("Step 9: Idempotency Check")
    rc, stdout, stderr = run_cmd("python3 notion_warroom_bridge.py --once")
    rc2, stdout2, stderr2 = run_cmd("python3 notion_warroom_bridge.py --once")
    
    if "Pushed" in stdout or "Pushed" in stdout2 or "upserted" in stdout or "upserted" in stdout2:
        fail("Idempotency check failed: unexpected operations occurred when no files changed.")
    
    pass_check("Idempotency verified. No duplicate actions triggered.")
    
    print("\n\033[1;32m=== DEMO ACCEPTANCE COMPLETE! ALL CHECKS PASSED. ===\033[0m")

if __name__ == "__main__":
    main()
