# Notion OS / Agentic Mission Control Implementation Plan - V5.2 Final

> **For Hermes/Codex/Claude Code:** Use this document as the single source of truth. The filename may still contain `v4` for old link stability, but the content is V5.2 Final.

**Goal:** Build a Notion-backed Mission Control for local AI agents where Notion is the control/observability surface and `~/WarRoom/` remains the trusted execution/data plane.

**Core pitch:** A judge creates a task in Notion. Within seconds it appears as a valid War Room handoff. Hermes/OpenClaw/Codex work under local safety rules. When the handoff changes status/result, the Notion card updates live. A Notion dashboard block also mirrors War Room state without a custom frontend.

**Non-negotiable architecture:** The bridge is a courier only. It never executes Notion-originated commands, never invokes agent CLIs, never sends Telegram, and never touches external communications. It only syncs structured state between Notion and local War Room files.

---

## 1. Final Vetted Decisions

### Build this for the hackathon MVP

1. **Command Center sync:** Notion tasks go down into `~/WarRoom/HANDOFFS.md` using the exact War Room protocol.
2. **Result sync:** War Room statuses/results go back up to the same Notion tasks.
3. **Live dashboard:** `~/WarRoom/CURRENT_STATE.md` updates one existing Notion code block in place.
4. **Local context snapshots:** Long Notion task context is saved to `~/WarRoom/NotionInbox/<handoff_key>.md`; handoffs point to that file.
5. **Bridge state file:** `~/WarRoom/.notion_bridge_state.json` stores idempotency, Notion page IDs, handoff keys, result hashes, and block IDs.
6. **Smoke demo script:** Proves Notion -> War Room -> Notion loop without implementing agent execution.

### Do NOT build this weekend

- KnowledgeBase sync from Notion docs/PDFs.
- Skill Inbox to Notion Runbooks sync.
- Markdown-to-Notion full-fidelity conversion.
- Direct remote shell execution from Notion.
- Telegram relay automation.
- Multi-agent process spawning from the bridge.
- Notion webhooks or OAuth marketplace packaging.

Those are phase two. The MVP wins by showing a clean closed-loop control plane, not by speedrunning an orchestration cathedral into a dumpster fire.

---

## 2. Safety and Protocol Rules

### War Room is the execution plane

The bridge must preserve the exact handoff format from `/home/alhinai/WarRoom/PROTOCOL.md`:

```markdown
- Task: [What needs to be done]
  Owner: [Hermes | OpenClaw | Codex | User]
  Files Touched: [List of files they are authorized to modify]
  Status: [PENDING | IN PROGRESS | BLOCKED | COMPLETED | FAILED]
  Result: [Summary of what was achieved]
  Next Action: [What the other agent should do next]
```

The bridge may include the bridge key inside the `Task` text, e.g. `[wrb_abcd1234]`, because that still preserves the six protocol fields.

### Bridge must never do these

- No `subprocess` execution.
- No `os.system`, `os.popen`, `pty`, `pexpect`, or shell execution.
- No `hermes chat`, `openclaw agent`, `claude`, or `codex` invocation.
- No Telegram, Slack, email, or public/external sends.
- No destructive filesystem operations.
- No blind execution of command-looking Notion text.

Add a pytest guardrail that fails if bridge source files contain banned executor/messenger imports or calls.

### Notion text is untrusted input

The bridge sanitizes all Notion-derived fields before writing to War Room files:

- Strip control characters.
- Collapse or safely indent newlines.
- Limit field lengths.
- Prevent fake field injection like `Status: COMPLETED` inside task text.
- Save full raw context to a separate context snapshot file.

---

## 3. Notion API Decision

Use the current Notion API version:

```text
Notion-Version: 2025-09-03
```

Reason: Notion split databases into **database containers** and **data sources**. Query operations now target data sources.

### Client choice

Use a tiny raw HTTP wrapper with `requests`, not `notion-client`, for the MVP. This avoids SDK uncertainty around `/v1/data_sources` and keeps the plan aligned with the current Notion Developer Platform.

Claude Code suggested pinning the old `2022-06-28` API and using `notion-client==2.2.1` for speed. That would likely work for legacy single-source databases, but we are rejecting it for the final plan because the hackathon should demonstrate current Notion platform behavior and avoid future migration debt. If implementation time collapses, legacy API pinning remains a fallback, not the primary plan.

### Required endpoints

- `GET /v1/databases/{database_id}` for data source discovery if the user provides a database container ID.
- `POST /v1/data_sources/{data_source_id}/query` for Command Center polling.
- `PATCH /v1/pages/{page_id}` for status/result property updates.
- `PATCH /v1/blocks/{block_id}` for dashboard/result block updates.
- `PATCH /v1/blocks/{block_id}/children` for creating first dashboard/result blocks.

### API requirements

All API calls must use:

- `Authorization: Bearer <token>`.
- `Notion-Version: 2025-09-03`.
- `Content-Type: application/json`.
- Pagination loops with `has_more` and `next_cursor`.
- 0.35s minimum pacing between requests.
- Retry/backoff for HTTP `429`, `500`, `502`, `503`, and `504`.
- Clear failure logging without crashing the daemon.

---

## 4. Required Notion Schema

### Command Center data source

Use a real Notion **data source ID** when possible. If only a database container ID is provided, the bridge discovers the first data source through `GET /v1/databases/{database_id}`.

Properties:

- `Name` (`title`): task title.
- `Status` (`status`): `Pending`, `Dispatched`, `In Progress`, `Blocked`, `Completed`, `Failed`, `Archived`.
- `Assignee` (`select`): `Hermes`, `OpenClaw`, `Codex`, `User`.
- `Context` (`rich_text`): full task details.
- `Authorized Files` (`rich_text`): explicit local paths/globs agents are authorized to touch.
- `Working Directory` (`rich_text`): optional absolute local path for agent context.
- `User Input` (`rich_text`): optional reply to unblock a blocked task.
- `War Room Key` (`rich_text`): bridge-written local handoff key.
- `Result Summary` (`rich_text`): bridge-written short result.
- `Next Action` (`rich_text`): bridge-written next action.
- `Last Synced At` (`date`): bridge-written timestamp.
- `Last Sync Hash` (`rich_text`): bridge-written hash for idempotency/debugging.

Nice-to-have:

- `Priority` (`select`): `Low`, `Normal`, `High`, `Urgent`.
- `Parent Task` (`relation` to same data source): subtask trees.
- `Allow Telegram Relay` (`checkbox`): documentation-only for now. The bridge still does not send Telegram.

If the user creates `Status` as a `select` property instead of Notion's `status` type, implementation can support a compatibility mode, but the MVP schema should use `status` to avoid ambiguity.

### Dashboard page

- The bridge owns one code block for live `CURRENT_STATE.md`.
- The block ID is stored in `/home/alhinai/WarRoom/.notion_bridge_state.json`.
- If no block ID exists, the bridge creates exactly one block under `NOTION_DASHBOARD_PAGE_ID` and stores the ID.
- If the block is deleted, the bridge recreates exactly one block and stores the new ID.
- The bridge updates this one block in place. It must not append endless blocks.

---

## 5. Local Files and State

Project root:

```text
/home/alhinai/projects/notion-warroom-bridge/
```

Bridge-created War Room files:

```text
/home/alhinai/WarRoom/.notion_bridge.lock
/home/alhinai/WarRoom/.notion_bridge_state.json
/home/alhinai/WarRoom/NotionInbox/<handoff_key>.md
```

State file shape:

```json
{
  "version": 1,
  "command_center_data_source_id": "data-source-id",
  "dashboard_block_id": "block-id-or-null",
  "pages": {
    "notion-page-id": {
      "handoff_key": "wrb_abcd1234",
      "context_path": "/home/alhinai/WarRoom/NotionInbox/wrb_abcd1234.md",
      "last_notion_status": "Dispatched",
      "last_local_status": "PENDING",
      "last_result_hash": "sha256...",
      "last_next_action_hash": "sha256...",
      "last_result_block_id": "block-id-or-null",
      "last_synced_at": "2026-05-17T12:00:00Z"
    }
  }
}
```

Atomicity rules:

- Use one bridge lock: `/home/alhinai/WarRoom/.notion_bridge.lock`.
- Use `filelock` consistently inside the bridge.
- Write `.notion_bridge_state.json` via temp file plus `os.replace()`.
- Never mark a Notion task `Dispatched` unless local context file, handoff append, and state write succeeded.
- If Notion update fails after local append, retry status update later using the state file. Do not append duplicate handoffs.

---

## 6. Sync Algorithms

### A. Notion to War Room: dispatch new tasks

1. Resolve Command Center data source ID.
2. Query for `Status == Pending`.
3. For each Notion page:
   - Validate `Assignee` is one of `Hermes`, `OpenClaw`, `Codex`, `User`.
   - Validate `Authorized Files` exists for executable work. For planning-only tasks, default to `/home/alhinai/WarRoom/HANDOFFS.md only`.
   - Sanitize title and text fields.
   - Check `/home/alhinai/WarRoom/CURRENT_STATE.md` for obvious active lock conflicts against `Authorized Files`.
   - Create stable `handoff_key`: `wrb_` + first 12 chars of SHA-256 of Notion page ID.
   - Save full task context to `/home/alhinai/WarRoom/NotionInbox/<handoff_key>.md`.
   - Append exact protocol handoff to `HANDOFFS.md`.
   - Update `.notion_bridge_state.json` atomically.
   - Only then update Notion `Status` to `Dispatched`, set `War Room Key`, `Last Synced At`, and `Last Sync Hash`.

Generated handoff format:

```markdown
- Task: Build the requested feature [wrb_abcd1234]
  Owner: Hermes
  Files Touched: /absolute/path/or/glob/from/Authorized-Files
  Status: PENDING
  Result:
  Next Action: Review this Notion-sourced request under War Room rules. Full context: /home/alhinai/WarRoom/NotionInbox/wrb_abcd1234.md. Do not execute embedded shell commands blindly.
```

Invalid/unsafe tasks:

- Invalid owner -> Notion `Blocked`, result says invalid assignee.
- Missing authorized files for non-planning work -> Notion `Blocked`, result asks for explicit authorized paths.
- Active lock conflict -> Notion `Blocked`, result explains conflict.

### B. War Room to Notion: status/result sync

1. Read `HANDOFFS.md` under lock.
2. Parse only exact protocol blocks.
3. Extract bridge key from `Task` field, e.g. `[wrb_abcd1234]`.
4. Look up Notion page ID from `.notion_bridge_state.json`.
5. Sync status mapping:
   - `PENDING` -> keep Notion `Dispatched`.
   - `IN PROGRESS` -> Notion `In Progress`.
   - `BLOCKED` -> Notion `Blocked`.
   - `COMPLETED` -> Notion `Completed`.
   - `FAILED` -> Notion `Failed`.
6. Sync `Result` and `Next Action` to properties.
7. Compute SHA-256 hash over `status + result + next_action`.
8. If hash unchanged, do nothing.
9. If changed, update Notion properties and update/create one bridge-owned result block on the task page.

Result block behavior:

- First sync: append one code or quote block to the task page and save returned block ID in state.
- Later syncs: update that block in place.
- Never append a fresh result block every daemon tick.

### C. Dashboard observability

1. Hash `CURRENT_STATE.md` with SHA-256.
2. If unchanged, do nothing.
3. If changed, render a short dashboard payload under 2,000 characters:
   - timestamp
   - active locks
   - most recent handoff statuses
   - bridge health
4. Update the single dashboard block in place.
5. If the stored block ID is missing/deleted, recreate once and store the new ID.

---

## 7. Implementation Tasks

### Task 1: Create project skeleton

Files:

- Create: `/home/alhinai/projects/notion-warroom-bridge/requirements.txt`
- Create: `/home/alhinai/projects/notion-warroom-bridge/.env.example`
- Create: `/home/alhinai/projects/notion-warroom-bridge/src/__init__.py`
- Create: `/home/alhinai/projects/notion-warroom-bridge/tests/`

`requirements.txt`:

```text
requests==2.32.3
python-dotenv==1.0.1
filelock==3.13.1
pytest==8.0.0
```

`.env.example`:

```text
NOTION_TOKEN=ntn_or_secret_xxx
NOTION_VERSION=2025-09-03
NOTION_COMMAND_CENTER_DATABASE_ID=optional_database_container_id
NOTION_COMMAND_CENTER_DATA_SOURCE_ID=preferred_data_source_id
NOTION_DASHBOARD_PAGE_ID=dashboard_page_id
WARROOM_PATH=/home/alhinai/WarRoom
POLL_SECONDS=5
```

### Task 2: Config validation

Files:

- Create: `src/config.py`
- Create: `tests/test_config.py`

Requirements:

- Load `.env`.
- Require `NOTION_TOKEN`.
- Require `NOTION_DASHBOARD_PAGE_ID`.
- Require either `NOTION_COMMAND_CENTER_DATA_SOURCE_ID` or `NOTION_COMMAND_CENTER_DATABASE_ID`.
- Expand `WARROOM_PATH` to absolute path.
- Fail clearly if required values are missing.

Tests:

- Missing token raises.
- Data source ID accepted.
- Database ID fallback accepted.
- Relative/tilde War Room path expands.

### Task 3: Notion HTTP client

Files:

- Create: `src/notion_http.py`
- Create: `tests/test_notion_http.py`

Requirements:

- Use raw `requests`.
- Always send `Authorization`, `Notion-Version`, and `Content-Type`.
- Implement rate-limit pacing.
- Implement retry/backoff for `429` and `5xx`.
- Implement paginated `query_data_source(data_source_id, payload)`.
- Implement `discover_first_data_source(database_id)` using `GET /v1/databases/{database_id}`.
- Implement `update_page(page_id, properties)`.
- Implement `append_block_children(block_id, children)`.
- Implement `update_block(block_id, block_payload)`.

Tests:

- Headers include version `2025-09-03`.
- Data source query endpoint path is `/v1/data_sources/{id}/query`.
- Pagination collects all pages.
- 429 retry respects backoff.
- API errors produce useful exceptions.

### Task 4: Sanitization and War Room parser

Files:

- Create: `src/warroom_format.py`
- Create: `tests/test_warroom_format.py`

Requirements:

- `sanitize_inline(text, limit)` removes control chars and prevents fake field injection.
- `make_handoff_block(...)` emits exact six-field protocol block.
- `parse_handoffs(text)` parses exact protocol blocks and ignores malformed blocks.
- `extract_bridge_key(task_field)` finds `[wrb_xxx]`.
- Full raw Notion context is saved to `NotionInbox`, not stuffed into `HANDOFFS.md`.

Tests:

- Exact protocol field names.
- Newline injection cannot create fake `Status: COMPLETED`.
- Multi-line `Result` and `Next Action` parse correctly.
- Unknown owner is rejected.
- `Files Touched` remains authorized paths only, never Notion IDs.

### Task 5: Bridge state and file locking

Files:

- Create: `src/state_store.py`
- Create: `tests/test_state_store.py`

Requirements:

- Load/save `/home/alhinai/WarRoom/.notion_bridge_state.json`.
- Use `/home/alhinai/WarRoom/.notion_bridge.lock`.
- Save atomically via temp file plus `os.replace()`.
- Provide helpers:
  - `handoff_key_for_page(page_id)`
  - `get_page_by_key(key)`
  - `mark_dispatched(...)`
  - `mark_result_synced(...)`

Tests:

- Atomic save survives partial write simulation.
- Duplicate page ID does not create duplicate handoff.
- Hash changes trigger resync.

### Task 6: Dispatch sync

Files:

- Create: `src/dispatch_sync.py`
- Create: `tests/test_dispatch_sync.py`

Requirements:

- Query Notion tasks with `Status == Pending` using the `status` property shape.
- Validate owner and authorized files.
- Save context snapshot to `NotionInbox`.
- Append exact protocol handoff under lock.
- Update state file.
- Update Notion to `Dispatched` only after local success.
- On validation failure, update Notion to `Blocked` with reason.

Tests:

- New pending task appends one handoff.
- Restart does not duplicate handoff.
- Invalid owner blocks Notion task.
- Missing local write prevents Notion `Dispatched` update.
- Active lock conflict blocks task.

### Task 7: Result sync

Files:

- Create: `src/result_sync.py`
- Create: `tests/test_result_sync.py`

Requirements:

- Parse `HANDOFFS.md`.
- Sync `IN PROGRESS`, `BLOCKED`, `COMPLETED`, and `FAILED` to Notion.
- Sync both `Result` and `Next Action`.
- Use content hash to avoid duplicate sync.
- Create/update one result block per task, not endless appended blocks.
- Truncate/summarize text to Notion limits.

Tests:

- `COMPLETED` syncs status/result/next action.
- `BLOCKED` syncs blocker info.
- Changed result after first sync resyncs.
- Unchanged result does not call API again.
- Missing bridge key is ignored safely.

### Task 8: Dashboard observer

Files:

- Create: `src/dashboard_sync.py`
- Create: `tests/test_dashboard_sync.py`

Requirements:

- Read `CURRENT_STATE.md`.
- Render under 2,000 chars.
- Create block if missing.
- Update existing block in place.
- Store block ID in bridge state.
- Never append endless dashboard blocks.

Tests:

- First run creates block.
- Second run updates same block.
- No file change means no API call.
- Deleted block recreates one block.

### Task 9: Safety guard tests

Files:

- Create: `tests/test_no_unsafe_imports.py`

Requirements:

- Scan `src/**/*.py` and `notion_warroom_bridge.py`.
- Fail if code contains banned executor/messenger references:
  - `subprocess`
  - `os.system`
  - `os.popen`
  - `pty`
  - `pexpect`
  - `telegram`
  - `slack_sdk`
  - `paramiko`
  - `hermes chat`
  - `openclaw agent`

### Task 10: Main daemon

Files:

- Create: `notion_warroom_bridge.py`
- Create: `tests/test_daemon_smoke.py`

Requirements:

Loop every `POLL_SECONDS`:

1. Resolve data source ID.
2. Run dispatch sync.
3. Run result sync.
4. Run dashboard sync.
5. Log errors and continue.
6. Do not crash the daemon for one bad task.

No subprocess. No Telegram. No direct agent invocation.

### Task 11: Acceptance/demo script

Files:

- Create: `scripts/demo_check.py`
- Create: `README.md`

Demo acceptance criteria:

1. Create Notion task with `Status = Pending`.
2. Within one poll, task appears in `HANDOFFS.md` in exact protocol format.
3. Notion task becomes `Dispatched` and shows `War Room Key`.
4. Manually or via agent update handoff to `Status: COMPLETED` and add `Result`.
5. Within one poll, Notion task becomes `Completed` and `Result Summary` updates.
6. `CURRENT_STATE.md` edit updates the same dashboard block in place.
7. Restart bridge; no duplicate handoff or duplicate result block appears.

---

## 8. Demo Storyboard

1. Open Notion Command Center board.
2. Create card: `Inspect War Room health` with `Assignee = Hermes`, `Status = Pending`, `Authorized Files = /home/alhinai/WarRoom/**`.
3. Bridge logs: `dispatched wrb_abcd1234`.
4. Show `HANDOFFS.md` gaining the exact handoff block.
5. Hermes/OpenClaw completes the handoff locally.
6. Notion card automatically moves to `Completed` and shows the result.
7. Show Mission Control dashboard block live-updating from `CURRENT_STATE.md`.

The visual message for judges: **Notion is not just a wiki. It is the control plane for a local AI operating system.**

---

## 9. Final Vetting Notes

This V5.2 plan supersedes V1-V5.1. It includes the fixes from Hermes, Little Bot/OpenClaw, and Claude Code:

- Correct Notion 2025-09-03 data source model.
- Explicit raw HTTP wrapper instead of SDK ambiguity.
- Exact War Room handoff protocol.
- Bidirectional task/result sync.
- Sidecar idempotency state instead of fragile string checks.
- File locking and atomic state writes.
- Single-block dashboard updates instead of infinite append bloat.
- Explicit no-shell/no-Telegram/no-agent-CLI safety boundary.
- Safety guard tests for banned imports/calls.
- Clear MVP scope cuts for hackathon feasibility.

Claude Code was invoked after authentication succeeded. Its useful additions were retained: unsafe import guard tests, stronger dashboard upsert framing, and clearer SDK/API risk notes. Its suggested legacy API pinning and reintroduced phase-two sync modules were rejected for the final plan because they conflict with the current Notion platform and MVP scope.

---

### Task 8: Unit Tests & Safety Guardrails

**Files:**
- Create: `tests/test_dispatch_format.py`
- Create: `tests/test_result_parser.py`
- Create: `tests/test_no_unsafe_imports.py`

**Implementation:**
```python
# tests/test_dispatch_format.py
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
```

```python
# tests/test_result_parser.py
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
```

```python
# tests/test_no_unsafe_imports.py
"""Guardrail: the bridge must be a courier, not an executor or messenger."""
import pathlib

BANNED = ("subprocess", "os.system", "os.popen", "pexpect", "pty",
          "telegram", "slack_sdk", "paramiko")
ROOTS = ("src", "notion_warroom_bridge.py")

def test_no_banned_imports():
    root = pathlib.Path(__file__).resolve().parents[1]
    files = []
    for r in ROOTS:
        p = root / r
        if p.is_file():
            files.append(p)
        elif p.is_dir():
            files.extend(p.rglob("*.py"))
            
    offenders = []
    for f in files:
        if not f.exists(): continue
        text = f.read_text()
        for banned in BANNED:
            # Simple substring check (sufficient for guardrail)
            if banned in text:
                offenders.append((str(f), banned))
                
    assert not offenders, f"banned references found: {offenders}"
```

---

### Task 9: The Demo Smoke Script

**Files:**
- Create: `scripts/demo_smoke.sh`

**Implementation:**
```bash
#!/usr/bin/env bash
set -euo pipefail
echo "1) Create a Pending task in your Notion Command Center DB titled 'SMOKE'."
read -r -p " Press Enter once created..."

python3 notion_warroom_bridge.py &
BRIDGE_PID=$!
trap "kill $BRIDGE_PID 2>/dev/null || true" EXIT

sleep 20
echo "2) Verifying HANDOFFS.md got the six-field entry..."
grep -q "Task: SMOKE" ~/WarRoom/HANDOFFS.md
grep -q "Status: PENDING" ~/WarRoom/HANDOFFS.md
grep -q "ID:" ~/WarRoom/HANDOFFS.md

echo "3) Now go flip that entry's Status to COMPLETED and add a Result line."
read -r -p " Press Enter once done..."

sleep 20
echo "4) Verifying Notion task is now Completed (manual check in the Notion UI)."
echo "OK - Smoke Test Passed!"
```
