# Notion OS: War Room Bridge

**Notion is not just a wiki. It is the control plane for a local AI operating system.**

The War Room Bridge connects Notion to local AI agents (Hermes, OpenClaw, Codex, etc.) via a secure, file-based handoff protocol. It turns a Notion Database into a "Command Center" where you can dispatch tasks to agents, and turns a Notion Page into a "Mission Control Dashboard" that live-updates with your local workspace state.

## Architecture and Safety Boundary

The bridge is designed with strict security isolation:
1. **Unidirectional Command Plane:** Notion tasks with `Status = Pending` are fetched by the bridge and appended to a local `~/WarRoom/HANDOFFS.md` file.
2. **Local Agent Execution:** The bridge **never** executes shell commands directly, **never** invokes agents, and **never** talks to Telegram. It simply writes the `.md` files. Your local agents (Hermes, OpenClaw) monitor these files under their own local safety locks.
3. **Bidirectional Result Sync:** When an agent updates a task in `HANDOFFS.md` to `COMPLETED` and provides a `Result`, the bridge detects the change and syncs it back up to the Notion Database, marking the card as `Completed`.
4. **Idempotency and Locks:** A local JSON state file maintains sync hashes so tasks aren't duplicated. File-level locks prevent race conditions between the bridge and active agents.

## Quickstart

### Prerequisites
- Python 3.9+
- A Notion integration token (`NOTION_TOKEN`)
- A Notion Database for tasks (`NOTION_COMMAND_CENTER_DATABASE_ID`)
- A Notion Page or Block for the dashboard (`NOTION_DASHBOARD_PAGE_ID`)

### Setup
1. Clone the repository and navigate to it:
   ```bash
   cd notion-os
   ```
2. Set up the virtual environment:
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```
3. Copy the example `.env` file and fill in your variables:
   ```bash
   cp .env.example .env
   # Edit .env with your NOTION_TOKEN, IDs, etc.
   ```

### Running the Bridge

Run the daemon continuously in the background (polls every 5 seconds by default):
```bash
python3 notion_warroom_bridge.py
```

Run a single pass for testing or cron-jobs (exits immediately after one sync cycle):
```bash
python3 notion_warroom_bridge.py --once
```

## Demo Script

To verify that the system works perfectly and meets all hackathon acceptance criteria, you can run the interactive demo script:

```bash
./scripts/demo_check.py
```

This script guides you through the full lifecycle:
1. Creating a task in Notion.
2. Passing the task to the local `HANDOFFS.md`.
3. Answering the task locally as an agent would.
4. Syncing the completed task back to Notion.
5. Verifying that live dashboard blocks are correctly upserted without duplication.

## Project Structure

- `notion_warroom_bridge.py`: Main daemon entry point.
- `src/notion_http.py`: Custom HTTP client (no SDK) with rate limiting (429/5xx backoff).
- `src/config.py`: Environment and configuration loader.
- `src/state_store.py`: Atomic JSON sidecar state for idempotency and file locks.
- `src/dispatch_sync.py`: Syncs Notion tasks -> War Room `HANDOFFS.md`.
- `src/result_sync.py`: Syncs War Room `HANDOFFS.md` -> Notion task completion.
- `src/state_observer.py`: Syncs War Room `CURRENT_STATE.md` -> Notion dashboard block.

## License

Internal War Room project.
