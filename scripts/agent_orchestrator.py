#!/usr/bin/env python3
"""War Room Agent Orchestrator.

Runs alongside the Notion Bridge (which only handles HTTP sync).
This script tails HANDOFFS.md for PENDING tasks, dynamically routes them
to the appropriate agent CLI (Hermes, Claude Code, Codex, OpenClaw),
and updates HANDOFFS.md with the execution status and results.

This strictly maintains the air-gap between Notion and Agent Execution.
"""

import os
import re
import sys
import time
import subprocess
import threading
from pathlib import Path
from filelock import FileLock

sys.path.insert(0, str(Path(__file__).parent.parent.resolve()))
from src.warroom_format import parse_handoffs
from src.config import load_config

def update_task_in_file(warroom_path: str, task_id: str, new_status: str, new_result: str):
    handoff_path = os.path.join(warroom_path, "HANDOFFS.md")
    lock = FileLock(f"{handoff_path}.lock")
    
    with lock:
        if not os.path.exists(handoff_path):
            return
            
        with open(handoff_path, "r", encoding="utf-8") as f:
            content = f.read()
            
        blocks = re.split(r"(\n\s*\n+)", content)
        updated_blocks = []
        
        for block in blocks:
            if f"<!-- ID: {task_id} -->" in block or f"[{task_id}]" in block:
                # Update Status using precise [ \t] to avoid swallowing newlines
                block = re.sub(r"(^[ \t]*(?:-[ \t]+)?Status[ \t]*:[ \t]*).*$", rf"\g<1>{new_status}", block, flags=re.MULTILINE)
                
                # Update Result (if provided)
                if new_result:
                    safe_result = new_result.replace("\n", " ")[:1900]
                    if re.search(r"^[ \t]*(?:-[ \t]+)?Result[ \t]*:.*$", block, flags=re.MULTILINE):
                        block = re.sub(r"(^[ \t]*(?:-[ \t]+)?Result[ \t]*:[ \t]*).*$", rf"\g<1>{safe_result}", block, flags=re.MULTILINE)
                    else:
                        block += f"\n  Result: {safe_result}"
            updated_blocks.append(block)
            
        with open(handoff_path, "w", encoding="utf-8") as f:
            f.write("".join(updated_blocks))

def execute_task(task_id: str, owner: str, prompt: str, warroom_path: str):
    print(f"[{task_id}] Dispatching to {owner}...")
    update_task_in_file(warroom_path, task_id, "IN PROGRESS", "(Agent executing task...)")
    
    owner = owner.lower()
    cmd = []
    
    # Routing Logic
    if "hermes" in owner:
        cmd = ["hermes", "chat", "-Q", "-q", prompt]
    elif "codex" in owner:
        cmd = ["codex", "exec", prompt]
    elif "claude" in owner or "claudecode" in owner:
        cmd = ["claude", "--permission-mode", "bypassPermissions", "-p", prompt]
    elif "openclaw" in owner:
        # Fallback to claude for headless execution if openclaw isn't configured for one-shot CLI execution
        cmd = ["claude", "--permission-mode", "bypassPermissions", "-p", prompt]
    else:
        # Unknown agent -> Claude
        cmd = ["claude", "--permission-mode", "bypassPermissions", "-p", prompt]
        
    try:
        print(f"[{task_id}] Running: {' '.join(cmd)}")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        output = result.stdout.strip()
        if not output and result.stderr:
            output = "Error: " + result.stderr.strip()
        if not output:
            output = "Task completed successfully (no output)."
        print(f"[{task_id}] Completed.")
        update_task_in_file(warroom_path, task_id, "COMPLETED", output)
    except subprocess.TimeoutExpired:
        print(f"[{task_id}] Timed out.")
        update_task_in_file(warroom_path, task_id, "FAILED", "Agent execution timed out after 120s.")
    except Exception as e:
        print(f"[{task_id}] Failed: {e}")
        update_task_in_file(warroom_path, task_id, "FAILED", f"Error launching agent: {e}")

def main():
    print("🤖 Starting War Room Agent Orchestrator...")
    
    base_dir = Path(__file__).parent.parent.resolve()
    env_file = base_dir / ".env"
    config = load_config(env_file=env_file if env_file.exists() else None)
    warroom = str(config.warroom_path)
    handoff_path = os.path.join(warroom, "HANDOFFS.md")
    
    active_tasks = set()

    while True:
        if os.path.exists(handoff_path):
            lock = FileLock(f"{handoff_path}.lock")
            with lock:
                with open(handoff_path, "r", encoding="utf-8") as f:
                    content = f.read()
                    
            for task_id, fields in parse_handoffs(content):
                status = fields.get("Status", "").strip().upper()
                owner = fields.get("Owner", "").strip()
                
                # Ignore User tasks
                if owner.lower() == "user":
                    continue
                    
                if status == "PENDING" and task_id not in active_tasks:
                    active_tasks.add(task_id)
                    prompt = fields.get("Next Action", fields.get("Task", "Execute task"))
                    
                    t = threading.Thread(target=execute_task, args=(task_id, owner, prompt, warroom))
                    t.start()
                    
        time.sleep(5)

if __name__ == "__main__":
    main()
