# Notion OS War Room Bridge

A highly secure, zero-execution courier daemon that bridges a Notion workspace with a local headless AI War Room. 

## 🏗️ Architecture (V6 Final MVP)

The bridge implements a strict **Closed-Loop Control Plane**. Notion acts as the command center, and the local War Room (a set of markdown files) acts as the execution plane for autonomous AI agents like Hermes and OpenClaw.

**Core Directives:**
- **Zero Execution:** The bridge NEVER calls `subprocess`, `os.system`, or shell commands. It cannot be used to execute arbitrary code from Notion.
- **Idempotency First:** `StateStore` provides robust cross-process file-locking (`.lock`) and atomic writes via temporary file swapping (`os.replace`).
- **HTTP Pacing:** A custom `NotionHTTPClient` correctly handles Notion API rate limits, backoffs (via `Retry-After`), and 5xx errors.
- **Single Dashboard Block:** Updates `CURRENT_STATE.md` into a single Notion code block in-place instead of endlessly appending.

## 🚀 Setup

1. **Clone & Virtual Environment:**
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Configuration:**
   Create a `.env` file in the project root:
   ```env
   NOTION_TOKEN=ntn_your_integration_token
   NOTION_DASHBOARD_PAGE_ID=uuid_of_dashboard_page
   NOTION_COMMAND_CENTER_DATABASE_ID=uuid_of_dispatch_database
   NOTION_VERSION=2022-06-28
   WARROOM_PATH=/home/alhinai/WarRoom
   POLL_SECONDS=5
   ```

3. **Database Schema Requirements:**
   The Notion database needs the following exact properties:
   - `Name` (title)
   - `Status` (status: Pending, Dispatched, In Progress, Blocked, Completed, Failed)
   - `Assignee` (select: Hermes, OpenClaw, Codex, User)
   - `Authorized Files` (rich_text)
   - `War Room Key` (rich_text)
   - `Result Summary` (rich_text)
   - `Next Action` (rich_text)
   - `Last Synced At` (date)
   - `Last Sync Hash` (rich_text)

## 💻 Usage

Start the background polling daemon:
```bash
python3 notion_warroom_bridge.py
```

Or trigger a one-shot sync manually (useful for tests or cron):
```bash
python3 notion_warroom_bridge.py --once
```

## ✅ Running the Demo

To prove the loop end-to-end for the hackathon judges:

```bash
./scripts/demo_check.py
```

This interactive script guides you through the exact acceptance criteria, validating:
1. Dispatch from Notion to `HANDOFFS.md`
2. Syncing of results back to Notion
3. Real-time observability syncing of `CURRENT_STATE.md`
4. Strict idempotency (no duplicate operations).

## 🧪 Testing
The codebase uses `pytest` and boasts 88 tests covering API behavior, format parsing, file locking, and zero-execution guardrails.

```bash
pytest tests/
```
